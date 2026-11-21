//! Offline Unix transport and fake SDK delivery; no app, audio or remote calls.
use super::*;
use std::os::unix::{fs::PermissionsExt, net::UnixListener};

struct Fixture {
    dir: PathBuf,
    listener: UnixListener,
    settings: Settings,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tq-wire-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.join("s");
        let listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let descriptor = dir.join("d");
        fs::write(&descriptor, json!({"schema":"talkqte.lab.descriptor.v1","runId":"fictional-run","socketPath":path,"nonce":"a".repeat(64)}).to_string()).unwrap();
        fs::set_permissions(&descriptor, fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            dir,
            listener,
            settings: Settings {
                bounded_history: false,
                selected_prior: false,
                attested: None,
                backend: Backend::Subscription,
                spend_cap_micro_usd: None,
                descriptor,
                provider: "codex".into(),
                model: "gpt-6.1-sol".into(),
                effort: "medium".into(),
            },
        }
    }
    fn link(&self, sample: Option<ClockSample>) -> Arc<Link> {
        Link::new(
            self.settings.clone(),
            Arc::new(Mutex::new(Some(Arc::new(move || sample)))),
            Arc::new(AtomicBool::new(false)),
        )
    }
    fn accept(&self) -> UnixStream {
        let (s, _) = self.listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        s.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
        s
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
fn read(reader: &mut Reader, stream: &mut UnixStream) -> Value {
    let end = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(Instant::now() < end, "peer did not send a frame");
        if let Some(v) = reader.read(stream).unwrap() {
            return v;
        }
    }
}
fn handshake(stream: &mut UnixStream, reader: &mut Reader) {
    let hello = read(reader, stream);
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["nonce"], "a".repeat(64));
    assert_eq!(hello["sessionId"], "7");
    let mut ready = frame("ready", "fictional-run", 7);
    ready.as_object_mut().unwrap().extend(json!({"provider":"codex","model":"gpt-6.1-sol","effort":"medium","dispatchBudgetKind":"cliDispatchAttempts","dispatchLimit":100,"dispatchesUsed":0}).as_object().unwrap().clone());
    let mut probe = frame("clock_probe", "fictional-run", 7);
    probe["probeId"] = json!("one-probe");
    // A coalesced socket read must preserve ready/probe ordering.
    let bytes = format!("{}\n{}\n", ready, probe);
    stream.write_all(bytes.as_bytes()).unwrap();
}
type Started = (
    SyncSender<Event>,
    Receiver<Result<String, Failure>>,
    thread::JoinHandle<Result<(), Failure>>,
);
fn start(link: Arc<Link>, budget: Duration) -> Started {
    let (tx, rx) = mpsc::sync_channel(QUEUE);
    let (reply, replies) = mpsc::sync_channel(1);
    let first = Event::Evaluate {
        identity: Identity {
            session: 7,
            request: 1,
            context: 3,
        },
        input: json!({"events":[{"id":"transcript:line-1","text":"Who owns the fictional checklist?"}],"existingCue":null,"userName":null,"earlierCues":[]}),
        until: Instant::now() + budget,
        reply,
    };
    let handle = thread::spawn(move || transport(&link, rx, first));
    (tx, replies, handle)
}
fn sample() -> ClockSample {
    ClockSample {
        session_id: 7,
        elapsed_ms: 1250,
    }
}
fn result() -> Value {
    let mut v = frame("result", "fictional-run", 7);
    Identity {
        session: 7,
        request: 1,
        context: 3,
    }
    .add(&mut v);
    v["value"] = json!({"action":"quiet","cue":null,"sourceIds":["transcript:line-1"]});
    v["elapsedMs"] = json!(1);
    v
}
#[test]
fn clock_precedes_object_input_and_settlement_precedes_next_dispatch() {
    let f = Fixture::new();
    let link = f.link(Some(sample()));
    let (tx, replies, job) = start(link, Duration::from_secs(2));
    let mut s = f.accept();
    let mut reader = Reader::default();
    handshake(&mut s, &mut reader);
    let clock = read(&mut reader, &mut s);
    assert_eq!(clock["type"], "clock_sample");
    assert_eq!(clock["nativeSessionElapsedMs"], 1250);
    let eval = read(&mut reader, &mut s);
    assert_eq!(eval["type"], "evaluate");
    assert!(eval["input"].is_object());
    assert_eq!(eval["contextRevision"], "3");
    assert!(eval["budgetMs"].as_u64().unwrap() <= 2000);
    write_frame(&mut s, &result()).unwrap();
    assert!(replies
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .is_ok());
    // No next admission is possible before the exact Rust settlement.
    tx.send(Event::Settled(
        Identity {
            session: 7,
            request: 1,
            context: 3,
        },
        Settlement::StaleSuccess,
    ))
    .unwrap();
    let (reply, _) = mpsc::sync_channel(1);
    tx.send(Event::Evaluate {
        identity: Identity {
            session: 7,
            request: 2,
            context: 4,
        },
        input: json!({"events":[]}),
        until: Instant::now() + Duration::from_secs(1),
        reply,
    })
    .unwrap();
    assert_eq!(read(&mut reader, &mut s)["verdict"], "staleSuccess");
    assert_eq!(read(&mut reader, &mut s)["requestId"], "2");
    let mut terminal = frame("terminal", "fictional-run", 7);
    terminal["code"] = json!("provider_failed");
    write_frame(&mut s, &terminal).unwrap();
    assert!(job.join().unwrap().is_err());
}
#[test]
fn unavailable_or_foreign_clock_never_dispatches() {
    for sample in [
        None,
        Some(ClockSample {
            session_id: 8,
            elapsed_ms: 1250,
        }),
    ] {
        let f = Fixture::new();
        let (_tx, _reply, job) = start(f.link(sample), Duration::from_secs(1));
        let mut s = f.accept();
        handshake(&mut s, &mut Reader::default());
        assert!(job.join().unwrap().is_err());
        let mut bytes = Vec::new();
        s.read_to_end(&mut bytes).unwrap();
        assert!(bytes.is_empty());
    }
}
#[test]
fn missing_or_mismatched_settlement_is_terminal() {
    for wrong in [false, true] {
        let f = Fixture::new();
        let (tx, replies, job) = start(f.link(Some(sample())), Duration::from_secs(2));
        let mut s = f.accept();
        let mut r = Reader::default();
        handshake(&mut s, &mut r);
        read(&mut r, &mut s);
        read(&mut r, &mut s);
        write_frame(&mut s, &result()).unwrap();
        replies
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        if wrong {
            tx.send(Event::Settled(
                Identity {
                    session: 7,
                    request: 1,
                    context: 999,
                },
                Settlement::Current,
            ))
            .unwrap();
        }
        assert_eq!(
            job.join().unwrap(),
            Err(if wrong {
                Failure::InvalidDecision
            } else {
                Failure::Expired
            })
        );
    }
}
#[test]
fn duplicate_clock_and_foreign_result_are_rejected() {
    for clock in [false, true] {
        let f = Fixture::new();
        let (_tx, _reply, job) = start(f.link(Some(sample())), Duration::from_secs(2));
        let mut s = f.accept();
        let mut r = Reader::default();
        handshake(&mut s, &mut r);
        read(&mut r, &mut s);
        read(&mut r, &mut s);
        let mut v = if clock {
            frame("clock_probe", "fictional-run", 7)
        } else {
            result()
        };
        if clock {
            v["probeId"] = json!("again");
        } else {
            v["requestId"] = json!("2");
        }
        write_frame(&mut s, &v).unwrap();
        assert_eq!(job.join().unwrap(), Err(Failure::InvalidDecision));
    }
}
#[test]
fn descriptor_permissions_symlinks_and_frame_bounds_fail_closed() {
    let f = Fixture::new();
    assert!(descriptor(&f.settings).is_ok());
    fs::set_permissions(&f.settings.descriptor, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(descriptor(&f.settings).is_err());
    fs::remove_file(&f.settings.descriptor).unwrap();
    std::os::unix::fs::symlink("missing", &f.settings.descriptor).unwrap();
    assert!(descriptor(&f.settings).is_err());
    let (mut a, mut b) = UnixStream::pair().unwrap();
    a.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let sender = thread::spawn(move || {
        let _ = b.write_all(&vec![b'x'; FRAME_LIMIT + 1]);
    });
    let mut r = Reader::default();
    loop {
        match r.read(&mut a) {
            Ok(None) => {}
            Err(Failure::InvalidDecision) => break,
            v => panic!("unexpected {v:?}"),
        }
    }
    sender.join().unwrap();
}
#[test]
fn constructor_is_inert_and_publication_or_control_contention_is_terminal() {
    let f = Fixture::new();
    fs::remove_file(&f.settings.descriptor).unwrap();
    let link = f.link(Some(sample()));
    assert!(link.terminal().is_none());
    link.fault.store(true, Ordering::Release);
    assert_eq!(link.terminal(), Some(Failure::WorkerUnavailable));
}

fn shown_engine() -> Engine {
    struct Show;
    impl Evaluator for Show {
        fn evaluate(&mut self, _: &Request, _: &Cancellation) -> Result<String, Failure> {
            Ok(json!({"action":"show","cue":"Who owns the checklist?","sourceIds":["transcript:fictional-1"]}).to_string())
        }
    }
    let processor = ProcessorConfiguration::new(
        "lab-subscription".into(),
        1,
        "gpt-6.1-sol".into(),
        ProcessingLocation::Hosted {
            service: "Fictional stand-in".into(),
        },
        "test".into(),
        ProcessorDisclosure::new("Codex".into(), "Fictional offline test".into()).unwrap(),
    )
    .unwrap()
    .without_notes();
    let mut e = Engine::live_with_evaluator(
        Worker::start(Show, Duration::from_secs(1)).unwrap(),
        processor,
    );
    e.start().unwrap();
    let review = e
        .review_processing(crate::engine::ConversationScope::RecentAndNewSpeech, &[])
        .unwrap();
    e.approve_processing(review).unwrap();
    e.advance(10);
    e.ingest(
        e.session(),
        crate::engine::Segment {
            id: "fictional-1".into(),
            at_ms: 10,
            speaker: "Maya".into(),
            text: "Who owns the fictional checklist?".into(),
        },
    )
    .unwrap();
    let end = Instant::now() + Duration::from_secs(1);
    while e.state.cue.is_none() {
        assert!(Instant::now() < end);
        e.advance(1);
        thread::sleep(Duration::from_millis(1));
    }
    e
}
#[test]
fn published_cue_preserves_origin_through_hold_resolve_and_clear_and_filters_private_context() {
    let mut e = shown_engine();
    let mut state = Observations::default();
    let first = state.observe(&e, &e.cue_snapshot()).unwrap();
    let origin = first["currentCue"].clone();
    let id = origin["cueId"].as_str().unwrap();
    assert_eq!(origin["requestId"], "1");
    assert_eq!(origin["decider"], "model");
    assert_eq!(e.cue_snapshot().model_provider.as_deref(), Some("Codex"));
    assert!(state.observe(&e, &e.cue_snapshot()).is_none());
    e.inspect_cue(id).unwrap();
    e.advance(20);
    let held = state.observe(&e, &e.cue_snapshot()).unwrap();
    assert_eq!(
        held["currentCue"]["publishedAtNativeMs"],
        origin["publishedAtNativeMs"]
    );
    assert_eq!(
        held["currentCue"]["decisionAtNativeMs"],
        origin["decisionAtNativeMs"]
    );
    assert_eq!(held["currentCue"]["held"], true);
    // Runtime supplies the resolved-visible snapshot; the observer retains the
    // original Show provenance rather than the later resolver's identity.
    let mut snapshot = e.cue_snapshot();
    snapshot.revision += 1;
    snapshot.cue.as_mut().unwrap().resolved_by = Some(crate::engine::Resolution {
        source_id: "transcript:fictional-2".into(),
        evidence: "Maya owns it.".into(),
        sources: vec![],
    });
    let resolved = state.observe(&e, &snapshot).unwrap();
    assert_eq!(resolved["currentCue"]["resolved"], true);
    assert_eq!(resolved["currentCue"]["requestId"], origin["requestId"]);
    snapshot.revision += 1;
    snapshot.cue.as_mut().unwrap().about_focus = true;
    let filtered = state.observe(&e, &snapshot).unwrap();
    assert!(filtered["currentCue"].is_null());
    assert_eq!(filtered["cleared"][0]["cueId"], id);
    assert!(!filtered.to_string().contains("checklist"));
    snapshot.revision += 1;
    snapshot.cue = None;
    let clear = state.observe(&e, &snapshot).unwrap();
    assert!(clear["cleared"].as_array().unwrap().is_empty());
}
#[test]
fn failed_publication_and_queue_overflow_terminate_without_blocking() {
    let e = shown_engine();
    let f = Fixture::new();
    let link = f.link(Some(sample()));
    link.session.store(e.session(), Ordering::Release);
    link.started.store(true, Ordering::Release);
    let now = Instant::now();
    link.observe(&e, &e.cue_snapshot(), false);
    assert!(now.elapsed() < Duration::from_millis(100));
    assert_eq!(link.terminal(), Some(Failure::WorkerUnavailable));
    // Hold handshake admission open while the actual bounded Link queue fills.
    let link = f.link(Some(sample()));
    let (reply, _) = mpsc::sync_channel(1);
    link.send(Event::Evaluate {
        identity: Identity {
            session: 7,
            request: 1,
            context: 3,
        },
        input: json!({}),
        until: Instant::now() + Duration::from_secs(1),
        reply,
    })
    .unwrap();
    let mut stream = f.accept();
    let mut reader = Reader::default();
    assert_eq!(read(&mut reader, &mut stream)["type"], "hello");
    for _ in 0..QUEUE {
        link.send(Event::Observation(json!({}))).unwrap();
    }
    let at = Instant::now();
    assert_eq!(
        link.send(Event::Observation(json!({}))),
        Err(Failure::WorkerUnavailable)
    );
    assert!(at.elapsed() < Duration::from_millis(100));
    assert!(link.terminal().is_some());
}
#[test]
fn partial_frames_have_an_independent_deadline() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    a.set_read_timeout(Some(IO_SLICE)).unwrap();
    b.write_all(b"{").unwrap();
    let mut r = Reader::default();
    assert!(r.read(&mut a).unwrap().is_none());
    r.partial_since = Some(Instant::now() - Duration::from_secs(2));
    assert_eq!(r.read(&mut a), Err(Failure::Expired));
}

#[test]
fn missing_or_invalid_explicit_settings_never_select_another_provider() {
    let valid = [
        ("TALKQTE_DEV_CUE_BACKEND", "lab-subscription"),
        (
            "TALKQTE_DEV_LAB_DESCRIPTOR",
            "/fictional/private/descriptor",
        ),
        ("TALKQTE_DEV_LAB_PROVIDER", "codex"),
        ("TALKQTE_DEV_LAB_MODEL", "gpt-6.1-sol"),
        ("TALKQTE_DEV_LAB_EFFORT", "medium"),
    ];
    assert!(Settings::parse(|key| valid
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.to_string()))
    .is_ok());
    for (omit, _) in valid {
        assert!(Settings::parse(|key| if key == omit {
            None
        } else {
            valid
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        })
        .is_err());
        assert!(Settings::parse(|key| if key == omit {
            Some("invalid".into())
        } else {
            valid
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        })
        .is_err());
    }
}
#[test]
fn cancelled_queued_evaluation_cannot_dispatch_after_the_previous_settlement() {
    let f = Fixture::new();
    let link = f.link(Some(sample()));
    let (tx, replies, job) = start(link.clone(), Duration::from_secs(2));
    let mut s = f.accept();
    let mut r = Reader::default();
    handshake(&mut s, &mut r);
    read(&mut r, &mut s);
    read(&mut r, &mut s);
    write_frame(&mut s, &result()).unwrap();
    replies
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    // Stop may win while the engine queues its validation acknowledgement.
    link.cancel_reason(ControlReason::Stop);
    let _ = tx.send(Event::Settled(
        Identity {
            session: 7,
            request: 1,
            context: 3,
        },
        Settlement::Current,
    ));
    let (reply, _) = mpsc::sync_channel(1);
    let _ = tx.send(Event::Evaluate {
        identity: Identity {
            session: 7,
            request: 2,
            context: 4,
        },
        input: json!({}),
        until: Instant::now() + Duration::from_secs(1),
        reply,
    });
    assert!(job.join().unwrap().is_err());
    let mut tail = String::new();
    s.read_to_string(&mut tail).unwrap();
    assert!(!tail.contains("\"type\":\"evaluate\""));
}

#[test]
fn settlement_and_observation_lock_contention_fail_without_waiting_under_runtime() {
    let e = shown_engine();
    let f = Fixture::new();
    let link = f.link(Some(sample()));
    let request = Request::new(
        7,
        3,
        vec![crate::cue_evaluator::Source {
            id: "transcript:fictional-1".into(),
            revision: 1,
            provenance: crate::cue_evaluator::Provenance::Transcript {
                at_ms: 10,
                speaker: "Maya".into(),
            },
            text: "Who owns the fictional checklist?".into(),
        }],
        None,
    )
    .unwrap();
    let guard = link.pending.lock().unwrap();
    let now = Instant::now();
    assert_eq!(
        link.settle(&request, Settlement::Current),
        Err(Failure::WorkerUnavailable)
    );
    assert!(now.elapsed() < Duration::from_millis(100));
    drop(guard);
    let link = f.link(Some(sample()));
    link.started.store(true, Ordering::Release);
    link.session.store(e.session(), Ordering::Release);
    let guard = link.observations.lock().unwrap();
    let now = Instant::now();
    link.observe(&e, &e.cue_snapshot(), true);
    assert!(now.elapsed() < Duration::from_millis(100));
    assert!(link.terminal().is_some());
    drop(guard);
}
#[test]
fn identities_require_canonical_decimal_strings_without_js_precision_loss() {
    for invalid in [
        json!(7),
        json!("07"),
        json!("+7"),
        json!("7.0"),
        json!("7e0"),
        json!("18446744073709551616"),
    ] {
        assert!(!decimal_id(&invalid, 7));
    }
    assert!(decimal_id(&json!("18446744073709551615"), u64::MAX));
}

fn id(request: u64, context: u64) -> Identity {
    Identity {
        session: 7,
        request,
        context,
    }
}
fn result_for(request: u64, context: u64) -> Value {
    let mut v = result();
    id(request, context).add(&mut v);
    v
}
fn failed_for(request: u64, context: u64, code: &str) -> Value {
    let mut v = frame("failed", "fictional-run", 7);
    id(request, context).add(&mut v);
    v["code"] = json!(code);
    v
}
fn evaluate(
    tx: &SyncSender<Event>,
    request: u64,
    context: u64,
) -> Receiver<Result<String, Failure>> {
    let (reply, replies) = mpsc::sync_channel(1);
    tx.send(Event::Evaluate {
        identity: id(request, context),
        input: json!({"events":[]}),
        until: Instant::now() + Duration::from_secs(2),
        reply,
    })
    .unwrap();
    replies
}
fn opened(budget: Duration) -> (Fixture, Arc<Link>, Started, UnixStream, Reader) {
    let f = Fixture::new();
    let link = f.link(Some(sample()));
    let started = start(link.clone(), budget);
    let mut s = f.accept();
    let mut r = Reader::default();
    handshake(&mut s, &mut r);
    assert_eq!(read(&mut r, &mut s)["type"], "clock_sample");
    assert_eq!(read(&mut r, &mut s)["requestId"], "1");
    (f, link, started, s, r)
}
#[test]
fn native_deadline_retires_one_request_and_the_run_continues() {
    let (_f, link, (tx, replies, job), mut s, mut r) = opened(Duration::from_millis(300));
    // No reply in time: a request-scoped cancel, not a terminal one.
    let cancel = read(&mut r, &mut s);
    assert_eq!(cancel["type"], "cancel");
    assert_eq!(cancel["requestId"], "1");
    assert_eq!(cancel["contextRevision"], "3");
    assert_eq!(cancel["reason"], "deadline");
    assert!(replies.recv_timeout(Duration::from_secs(1)).is_err());
    tx.send(Event::Settled(id(1, 3), Settlement::Expired))
        .unwrap();
    // Late frames for the retired request are ignored.
    write_frame(&mut s, &result_for(1, 3)).unwrap();
    write_frame(&mut s, &failed_for(1, 3, "deadline")).unwrap();
    let replies = evaluate(&tx, 2, 4);
    assert_eq!(read(&mut r, &mut s)["requestId"], "2");
    write_frame(&mut s, &result_for(2, 4)).unwrap();
    assert!(replies
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .is_ok());
    tx.send(Event::Settled(id(2, 4), Settlement::Current))
        .unwrap();
    assert_eq!(read(&mut r, &mut s)["verdict"], "current");
    assert!(link.terminal().is_none());
    // Stop still ends the strict run.
    link.cancel_reason(ControlReason::Stop);
    let stop = read(&mut r, &mut s);
    assert_eq!(stop["type"], "cancel");
    assert_eq!(stop["reason"], "stop");
    assert!(job.join().unwrap().is_err());
}
#[test]
fn broker_deadline_retires_the_request_and_other_failures_still_end_the_run() {
    let (_f, link, (tx, _replies, job), mut s, mut r) = opened(Duration::from_millis(400));
    write_frame(&mut s, &failed_for(1, 3, "deadline")).unwrap();
    // Native's own expiry settles it later; nothing more is sent for it.
    thread::sleep(Duration::from_millis(450));
    tx.send(Event::Settled(id(1, 3), Settlement::Expired))
        .unwrap();
    let _replies = evaluate(&tx, 2, 4);
    let next = read(&mut r, &mut s);
    assert_eq!(next["type"], "evaluate");
    assert_eq!(next["requestId"], "2");
    assert!(link.terminal().is_none());
    write_frame(&mut s, &failed_for(2, 4, "unavailable")).unwrap();
    assert_eq!(job.join().unwrap(), Err(Failure::Unreachable));
}
#[test]
fn an_expiry_the_engine_never_confirms_is_terminal() {
    let (_f, _link, (_tx, _replies, job), mut s, mut r) = opened(Duration::from_millis(100));
    assert_eq!(read(&mut r, &mut s)["reason"], "deadline");
    assert_eq!(job.join().unwrap(), Err(Failure::Expired));
}
#[test]
fn a_result_read_too_late_settles_as_expired_and_the_run_continues() {
    let (_f, link, (tx, replies, job), mut s, mut r) = opened(Duration::from_secs(2));
    write_frame(&mut s, &result_for(1, 3)).unwrap();
    assert!(replies
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .is_ok());
    tx.send(Event::Settled(id(1, 3), Settlement::Expired))
        .unwrap();
    let settled = read(&mut r, &mut s);
    assert_eq!(settled["type"], "settled");
    assert_eq!(settled["requestId"], "1");
    assert_eq!(settled["verdict"], "expired");
    let _replies = evaluate(&tx, 2, 4);
    assert_eq!(read(&mut r, &mut s)["requestId"], "2");
    assert!(link.terminal().is_none());
    // A frame for a request that was never retired is still a fault.
    write_frame(&mut s, &result_for(5, 9)).unwrap();
    assert_eq!(job.join().unwrap(), Err(Failure::InvalidDecision));
}
#[test]
fn worker_deadline_retires_the_link_request_without_ending_the_link() {
    let f = Fixture::new();
    let link = f.link(Some(sample()));
    let mut worker = Worker::start(Adapter(link.clone()), Duration::from_millis(300)).unwrap();
    let request = Request::new(
        7,
        3,
        vec![crate::cue_evaluator::Source {
            id: "transcript:fictional-1".into(),
            revision: 1,
            provenance: crate::cue_evaluator::Provenance::Transcript {
                at_ms: 10,
                speaker: "Maya".into(),
            },
            text: "Who owns the fictional checklist?".into(),
        }],
        None,
    )
    .unwrap();
    worker.submit(request.clone()).unwrap();
    let mut s = f.accept();
    let mut r = Reader::default();
    handshake(&mut s, &mut r);
    read(&mut r, &mut s);
    assert_eq!(read(&mut r, &mut s)["type"], "evaluate");
    let end = Instant::now() + Duration::from_secs(2);
    let result = loop {
        if let Some(result) = worker.poll_submitted() {
            break result;
        }
        assert!(Instant::now() < end, "worker did not expire");
        thread::sleep(Duration::from_millis(5));
    };
    assert!(matches!(result, Err(Failure::Expired)));
    link.settle(&request, Settlement::Expired).unwrap();
    assert_eq!(read(&mut r, &mut s)["reason"], "deadline");
    while worker.is_busy() {
        assert!(Instant::now() < end, "adapter did not return");
        thread::sleep(Duration::from_millis(5));
    }
    assert!(link.terminal().is_none());
    // Leaving the session still ends the link.
    drop(worker);
    assert_eq!(read(&mut r, &mut s)["reason"], "exit");
}

fn api_settings(cap: Option<&str>, model: &str, effort: &str) -> Result<Settings, Failure> {
    let values = [
        ("TALKQTE_DEV_CUE_BACKEND", Some("lab-api")),
        (
            "TALKQTE_DEV_LAB_DESCRIPTOR",
            Some("/fictional/private/descriptor"),
        ),
        ("TALKQTE_DEV_LAB_PROVIDER", Some("anthropic-api")),
        ("TALKQTE_DEV_LAB_MODEL", Some(model)),
        ("TALKQTE_DEV_LAB_EFFORT", Some(effort)),
        ("TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD", cap),
    ];
    Settings::parse(|key| {
        values
            .iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, v)| v.map(str::to_string))
    })
}
#[test]
fn the_api_backend_takes_exactly_its_models_low_effort_and_a_spend_cap() {
    for model in ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] {
        let settings = api_settings(Some("250000"), model, "low").unwrap();
        assert_eq!(settings.backend, Backend::Api);
        assert_eq!(settings.spend_cap_micro_usd, Some(250_000));
        assert_eq!(settings.budget_kind(), "apiRequests");
    }
    assert!(api_settings(Some("250000"), "claude-opus-5-5", "medium").is_err());
    assert!(api_settings(Some("250000"), "claude-fable-5-1", "low").is_err());
    assert!(api_settings(Some("250000"), "gpt-6.1-sol", "low").is_err());
    assert!(api_settings(None, "claude-haiku-5-5", "low").is_err());
    for cap in ["", "0", "01", "1000001", "1.5", "-1", "+5", "250000 "] {
        assert!(
            api_settings(Some(cap), "claude-haiku-5-5", "low").is_err(),
            "{cap:?}"
        );
    }
    assert_eq!(
        api_settings(Some("1000000"), "claude-opus-5-5", "low")
            .unwrap()
            .spend_cap_micro_usd,
        Some(1_000_000)
    );
    // Each provider belongs to one backend, and a cap only to the API.
    let mixed = |backend: &str, provider: &str, model: &str, cap: Option<&str>| {
        let values = [
            ("TALKQTE_DEV_CUE_BACKEND", Some(backend)),
            (
                "TALKQTE_DEV_LAB_DESCRIPTOR",
                Some("/fictional/private/descriptor"),
            ),
            ("TALKQTE_DEV_LAB_PROVIDER", Some(provider)),
            ("TALKQTE_DEV_LAB_MODEL", Some(model)),
            ("TALKQTE_DEV_LAB_EFFORT", Some("low")),
            ("TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD", cap),
        ];
        Settings::parse(|key| {
            values
                .iter()
                .find(|(k, _)| *k == key)
                .and_then(|(_, v)| v.map(str::to_string))
        })
    };
    assert!(mixed("lab-api", "codex", "gpt-6.1-sol", Some("1000")).is_err());
    assert!(mixed("lab-api", "claude-code", "claude-haiku-5-5", Some("1000")).is_err());
    assert!(mixed(
        "lab-subscription",
        "anthropic-api",
        "claude-haiku-5-5",
        None
    )
    .is_err());
    assert!(mixed("lab-subscription", "codex", "gpt-6.1-sol", Some("1000")).is_err());
    let codex = mixed("lab-subscription", "codex", "gpt-6.1-sol", None).unwrap();
    assert_eq!(
        (codex.backend, codex.budget_kind()),
        (Backend::Subscription, "cliDispatchAttempts")
    );
}
#[test]
fn the_api_disclosure_names_the_destination_billing_and_cap() {
    let settings = api_settings(Some("250001"), "claude-sonnet-5-5", "low").unwrap();
    let (label, service, policy) = disclosure(Backend::Api, Some(&settings));
    assert_eq!(label, "Claude");
    assert!(service.contains("Anthropic API") && service.contains("billed per token"));
    // Rounded up, so the cap shown is never below the real one.
    assert!(policy.contains("per-run spend cap of $0.26"), "{policy}");
    assert!(policy.contains("No retries") || policy.contains("no retries"));
    assert!(!policy.contains("no API fallback"));
    assert!(!policy.contains("subscription;"));
    let (_, _, subscription) = disclosure(Backend::Subscription, None);
    assert!(subscription.contains("no API fallback"));
    assert_eq!(dollars(1_000_000), "$1.00");
    assert_eq!(dollars(1), "$0.01");
}
#[test]
fn the_ready_frame_must_match_the_backend_budget_and_cap() {
    let api = api_settings(Some("250000"), "claude-haiku-5-5", "low").unwrap();
    let ready = |extra: Value| {
        let mut v = frame("ready", "fictional-run", 7);
        v.as_object_mut().unwrap().extend(
            json!({"provider":"anthropic-api","model":"claude-haiku-5-5","effort":"low","dispatchBudgetKind":"apiRequests","dispatchLimit":20,"dispatchesUsed":0})
                .as_object()
                .unwrap()
                .clone(),
        );
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    };
    let ok = |v: &Value| ready_matches_settings(v, "fictional-run", 7, &api);
    assert_eq!(
        ok(&ready(
            json!({"spendCapMicroUsd":250000,"spendUsedMicroUsd":0})
        )),
        Ok(())
    );
    assert_eq!(
        ok(&ready(
            json!({"spendCapMicroUsd":250000,"spendUsedMicroUsd":250000})
        )),
        Ok(())
    );
    for bad in [
        json!({"spendCapMicroUsd":250001,"spendUsedMicroUsd":0}),
        json!({"spendCapMicroUsd":250000,"spendUsedMicroUsd":250001}),
        json!({"spendCapMicroUsd":"250000","spendUsedMicroUsd":0}),
        json!({"spendCapMicroUsd":250000}),
        json!({"dispatchBudgetKind":"cliDispatchAttempts","spendCapMicroUsd":250000,"spendUsedMicroUsd":0}),
    ] {
        assert_eq!(
            ok(&ready(bad.clone())),
            Err(Failure::InvalidDecision),
            "{bad}"
        );
    }
    // A subscription backend never accepts spend fields.
    let codex = Settings {
        bounded_history: false,
        selected_prior: false,
        attested: None,
        backend: Backend::Subscription,
        spend_cap_micro_usd: None,
        descriptor: "/fictional/private/descriptor".into(),
        provider: "codex".into(),
        model: "gpt-6.1-sol".into(),
        effort: "medium".into(),
    };
    let mut v = frame("ready", "fictional-run", 7);
    v.as_object_mut().unwrap().extend(json!({"provider":"codex","model":"gpt-6.1-sol","effort":"medium","dispatchBudgetKind":"cliDispatchAttempts","dispatchLimit":100,"dispatchesUsed":0}).as_object().unwrap().clone());
    assert_eq!(
        ready_matches_settings(&v, "fictional-run", 7, &codex),
        Ok(())
    );
    v["spendCapMicroUsd"] = json!(1000);
    assert_eq!(
        ready_matches_settings(&v, "fictional-run", 7, &codex),
        Err(Failure::InvalidDecision)
    );
}
#[test]
fn a_broker_output_limit_retires_one_request_like_a_refusal() {
    let (_f, link, (tx, replies, job), mut s, mut r) = opened(Duration::from_secs(2));
    write_frame(&mut s, &failed_for(1, 3, "output_limit")).unwrap();
    assert_eq!(
        replies.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(Failure::OutputLimit)
    );
    tx.send(Event::Settled(id(1, 3), Settlement::Retired))
        .unwrap();
    write_frame(&mut s, &failed_for(1, 3, "output_limit")).unwrap();
    let _replies = evaluate(&tx, 2, 4);
    assert_eq!(read(&mut r, &mut s)["requestId"], "2");
    assert!(link.terminal().is_none());
    write_frame(&mut s, &failed_for(9, 9, "output_limit")).unwrap();
    assert_eq!(job.join().unwrap(), Err(Failure::InvalidDecision));
}
#[test]
fn a_broker_refusal_retires_one_request_and_the_run_continues() {
    let (_f, link, (tx, replies, job), mut s, mut r) = opened(Duration::from_secs(2));
    write_frame(&mut s, &failed_for(1, 3, "refusal")).unwrap();
    assert_eq!(
        replies.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(Failure::Refused)
    );
    tx.send(Event::Settled(id(1, 3), Settlement::Retired))
        .unwrap();
    // Late frames for the refused request are ignored.
    write_frame(&mut s, &result_for(1, 3)).unwrap();
    let _replies = evaluate(&tx, 2, 4);
    let next = read(&mut r, &mut s);
    assert_eq!(
        next["type"], "evaluate",
        "nothing is sent for the refused request"
    );
    assert_eq!(next["requestId"], "2");
    assert!(link.terminal().is_none());
    // A refusal for a request that is not active is still a fault.
    write_frame(&mut s, &failed_for(9, 9, "refusal")).unwrap();
    assert_eq!(job.join().unwrap(), Err(Failure::InvalidDecision));
}
#[test]
fn an_unconfirmed_refusal_is_terminal() {
    let (_f, _link, (_tx, replies, job), mut s, _r) = opened(Duration::from_secs(5));
    write_frame(&mut s, &failed_for(1, 3, "refusal")).unwrap();
    assert_eq!(
        replies.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(Failure::Refused)
    );
    assert_eq!(job.join().unwrap(), Err(Failure::Expired));
}

pub(super) fn selected_settings() -> Settings {
    let mut settings = api_settings(Some("1000000"), "claude-opus-5-5", "low").unwrap();
    settings.selected_prior = true;
    settings
}

#[test]
fn selected_registration_disclosure_is_bounded_and_defaults_still_refuse_notes() {
    let settings = selected_settings();
    // Exact current cloud review sentence with its largest allowed minute cap.
    let audio="Audio: this approval also sends the live audio of the session's capture source (the microphone, or the selected application) to Deepgram (US, model Nova-3) for transcription. Each request asks Deepgram to opt out of its Model Improvement Program; what Deepgram keeps is set by its terms (https://deepgram.com/terms). Audio captured before this approval is never sent. At most 10 minutes of audio for this whole launch, across sessions and sources. If transcription stops, nothing is transcribed and nothing falls back to another service.";
    let selected = processor_configuration(
        Backend::Api,
        Some(&settings),
        Some(audio.into()),
        Some("Deepgram".into()),
    )
    .unwrap();
    let mut engine = Engine::live_with_evaluator(
        Worker::start(Adapter(Fixture::new().link(Some(sample()))), DEADLINE).unwrap(),
        selected,
    );
    engine.start().unwrap();
    // Empty selected review is explicit permission, not import or launch.
    let review = engine
        .review_processing(crate::engine::ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    engine.approve_processing(review).unwrap();
    assert!(engine.has_processing_permission());
    assert!(
        processor_configuration(Backend::Api, Some(&settings), Some("x".repeat(2048)), None)
            .is_err()
    );
    let legacy = api_settings(Some("1000000"), "claude-opus-5-5", "low").unwrap();
    let (_, _, policy) = disclosure(Backend::Api, Some(&legacy));
    assert!(policy.contains("Never sends the cue provider audio, prior notes"));
    let (_, _, policy) = disclosure(Backend::Api, Some(&settings));
    assert!(policy.contains("Approving no notes sends none"));
}

#[test]
fn selected_settings_and_ready_identity_fail_closed() {
    let values = [
        ("TALKQTE_DEV_CUE_BACKEND", "lab-api"),
        (
            "TALKQTE_DEV_LAB_DESCRIPTOR",
            "/fictional/private/descriptor",
        ),
        ("TALKQTE_DEV_LAB_PROVIDER", "anthropic-api"),
        ("TALKQTE_DEV_LAB_MODEL", "claude-opus-5-5"),
        ("TALKQTE_DEV_LAB_EFFORT", "low"),
        ("TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD", "1000000"),
    ];
    for mode in [SELECTED_CONTEXT, "bounded-history", "unknown"] {
        let parsed = Settings::parse(|key| {
            if key == "TALKQTE_DEV_LAB_CONTEXT" {
                Some(mode.into())
            } else {
                values
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v.to_string())
            }
        });
        assert_eq!(
            parsed.is_ok(),
            matches!(mode, SELECTED_CONTEXT | "bounded-history")
        );
        if let Ok(settings) = parsed {
            assert_eq!(settings.selected_prior, mode == SELECTED_CONTEXT);
            assert_eq!(settings.bounded_history, mode == "bounded-history");
            assert!(settings.attested.is_none());
        }
    }
    assert!(Settings::parse(|key| if key == "TALKQTE_DEV_LAB_CONTEXT" {
        Some(SELECTED_CONTEXT.into())
    } else {
        None
    })
    .is_err());
    let settings = selected_settings();
    let mut ready = settings.frame("ready", "fictional-run", 7);
    ready.as_object_mut().unwrap().extend(json!({"provider":"anthropic-api","model":"claude-opus-5-5","effort":"low","dispatchBudgetKind":"apiRequests","dispatchLimit":40,"dispatchesUsed":0,"spendCapMicroUsd":1000000,"spendUsedMicroUsd":0}).as_object().unwrap().clone());
    assert!(ready_matches_settings(&ready, "fictional-run", 7, &settings).is_err());
    ready
        .as_object_mut()
        .unwrap()
        .extend(settings.identity().as_object().unwrap().clone());
    assert_eq!(
        ready_matches_settings(&ready, "fictional-run", 7, &settings),
        Ok(())
    );
    for key in [
        "contextPolicy",
        "inputContract",
        "policyRevision",
        "promptSha256",
        "schema",
    ] {
        let mut bad = ready.clone();
        bad[key] = json!("wrong");
        assert!(ready_matches_settings(&bad, "fictional-run", 7, &settings).is_err());
    }
}

#[test]
fn selected_real_link_worker_projects_native_v2_and_retires_on_stop() {
    use crate::cue_evaluator::{Provenance, Source};
    for notes in [false, true] {
        let mut f = Fixture::new();
        let path = f.settings.descriptor.clone();
        f.settings = selected_settings();
        f.settings.descriptor = path.clone();
        let mut descriptor: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        descriptor["schema"] = json!("talkqte.lab.selected.descriptor.v2");
        fs::write(&path, descriptor.to_string()).unwrap();
        let link = f.link(Some(sample()));
        let mut worker = Worker::start(Adapter(link.clone()), DEADLINE).unwrap();
        let mut sources = vec![Source {
            id: "transcript:current".into(),
            revision: 0,
            provenance: Provenance::Transcript {
                at_ms: 10,
                speaker: "Maya".into(),
            },
            text: "Can we send the pack Friday?".into(),
        }];
        if notes {
            sources.push(Source {
                id: "prior:file:a".into(),
                revision: u64::MAX,
                provenance: Provenance::PriorNote {
                    provider: crate::context::Provider::File,
                    date: "2026-11-01".into(),
                    title: "Welcome pack review".into(),
                },
                text: "Review needs two days.".into(),
            });
        }
        let request = Request::new(7, 3, sources, None).unwrap();
        worker.submit(request.clone()).unwrap();
        let mut socket = f.accept();
        let mut reader = Reader::default();
        let hello = read(&mut reader, &mut socket);
        assert_eq!(hello["schema"], SELECTED_SCHEMA);
        for (key, value) in f.settings.identity().as_object().unwrap() {
            assert_eq!(&hello[key], value);
        }
        let mut ready = f.settings.frame("ready", "fictional-run", 7);
        ready
            .as_object_mut()
            .unwrap()
            .extend(f.settings.identity().as_object().unwrap().clone());
        ready.as_object_mut().unwrap().extend(json!({"provider":"anthropic-api","model":"claude-opus-5-5","effort":"low","dispatchBudgetKind":"apiRequests","dispatchLimit":40,"dispatchesUsed":0,"spendCapMicroUsd":1000000,"spendUsedMicroUsd":0}).as_object().unwrap().clone());
        write_frame(&mut socket, &ready).unwrap();
        let mut probe = f.settings.frame("clock_probe", "fictional-run", 7);
        probe["probeId"] = json!("selected-probe");
        write_frame(&mut socket, &probe).unwrap();
        assert_eq!(read(&mut reader, &mut socket)["schema"], SELECTED_SCHEMA);
        let evaluation = read(&mut reader, &mut socket);
        let expected: Value =
            serde_json::from_str(&request.selected_prior_context_input().unwrap()).unwrap();
        assert_eq!(evaluation["input"], expected);
        assert_eq!(
            evaluation["input"]["priorNotes"].as_array().unwrap().len(),
            usize::from(notes)
        );
        if notes {
            let fixture: Value = serde_json::from_str(include_str!(
                "../../scripts/fixtures/selected-context-input.json"
            ))
            .unwrap();
            assert_eq!(evaluation["input"], fixture);
        }
        // Stop while the fake reply is held; a reply already in flight cannot apply.
        link.cancel_reason(ControlReason::Stop);
        let mut late = f.settings.frame("result", "fictional-run", 7);
        id(1, 3).add(&mut late);
        late["elapsedMs"] = json!(1);
        late["value"] = json!({"action":"quiet","cue":null,"sourceIds":["transcript:current"]});
        let _ = write_frame(&mut socket, &late);
        let end = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(reply) = worker.poll_submitted() {
                assert!(reply.is_err());
                break;
            }
            assert!(Instant::now() < end);
            thread::sleep(Duration::from_millis(5));
        }
        drop(worker);
    }
}

fn attested_fixture(count: usize) -> Fixture {
    let mut f = Fixture::new();
    f.settings = selected_settings();
    f.settings.descriptor = f.dir.join("d");
    let authority = f.dir.join("authority");
    fs::write(&authority,json!({"schema":"talkqte.lab.scope-authority.v1","runId":"fictional-run","expectedCount":count,"key":"07".repeat(32)}).to_string()).unwrap();
    fs::set_permissions(&authority, fs::Permissions::from_mode(0o600)).unwrap();
    f.settings.attested = Some((authority, count));
    fs::write(&f.settings.descriptor,json!({"schema":crate::selected_attestation::DESCRIPTOR,"runId":"fictional-run","socketPath":f.dir.join("s"),"nonce":"a".repeat(64)}).to_string()).unwrap();
    f
}
fn attested_engine(f: &Fixture) -> (Engine, Arc<Link>, crate::context::ContextItem) {
    let item = crate::context::ContextItem {
        provider: crate::context::Provider::File,
        source_id: "fixture-note".into(),
        title: "Fictional workshop".into(),
        source_date: "2026-10-20".into(),
        excerpt: "The room cannot open before nine.".into(),
        revision: 1,
    };
    let link = f.link(Some(ClockSample {
        session_id: 1,
        elapsed_ms: 10,
    }));
    let config = processor_configuration(Backend::Api, Some(&f.settings), None, None).unwrap();
    assert_eq!(
        crate::engine::ProcessorSummary::from(&config).required_note_count,
        Some(f.settings.attested.as_ref().unwrap().1)
    );
    let mut e = Engine::live_with_evaluator(
        Worker::start(Adapter(link.clone()), DEADLINE).unwrap(),
        config,
    )
    .with_lab_lifecycle(link.clone());
    e.start().unwrap();
    e.set_notes(vec![item.clone()]);
    (e, link, item)
}
fn accept_attested_scope(f: &Fixture, session: u64) -> (UnixStream, Reader, Value) {
    let mut stream = f.accept();
    let mut reader = Reader::default();
    let hello = read(&mut reader, &mut stream);
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["contextPolicy"], crate::selected_attestation::CONTEXT);
    let mut ready = f.settings.frame("ready", "fictional-run", session);
    ready
        .as_object_mut()
        .unwrap()
        .extend(f.settings.identity().as_object().unwrap().clone());
    ready.as_object_mut().unwrap().extend(json!({"provider":"anthropic-api","model":"claude-opus-5-5","effort":"low","dispatchBudgetKind":"apiRequests","dispatchLimit":40,"dispatchesUsed":0,"spendCapMicroUsd":1000000,"spendUsedMicroUsd":0}).as_object().unwrap().clone());
    write_frame(&mut stream, &ready).unwrap();
    let grant = read(&mut reader, &mut stream);
    assert_eq!(grant["type"], "scope_approval");
    (stream, reader, grant)
}
#[test]
fn attested_real_review_link_handshake_and_worker_preserve_exact_note_before_audio_and_request() {
    let f = attested_fixture(1);
    let (mut engine, link, item) = attested_engine(&f);
    assert!(engine
        .review_processing(crate::engine::ConversationScope::NewSpeechOnly, &[])
        .is_err());
    assert!(!engine.has_processing_permission());
    assert!(engine.audio_approval(1).is_none());
    let review = engine
        .review_processing(
            crate::engine::ConversationScope::NewSpeechOnly,
            &[(item.provider, item.source_id.clone(), item.revision)],
        )
        .unwrap();
    engine.approve_processing(review).unwrap();
    assert!(engine.audio_approval(1).is_none());
    let (mut stream, mut reader, grant) = accept_attested_scope(&f, 1);
    let proof: crate::selected_attestation::Scope =
        serde_json::from_value(grant["scope"].clone()).unwrap();
    assert_eq!(proof.note_count, 1);
    let mut ack = grant;
    ack["type"] = json!("scope_ready");
    write_frame(&mut stream, &ack).unwrap();
    let current = read(&mut reader, &mut stream);
    assert_eq!(current["type"], "scope_current");
    assert!(link.scope_ready());
    assert!(engine.audio_approval(1).is_some());
    let mut probe = f.settings.frame("clock_probe", "fictional-run", 1);
    probe["probeId"] = json!("scope-probe");
    write_frame(&mut stream, &probe).unwrap();
    assert_eq!(read(&mut reader, &mut stream)["type"], "clock_sample");
    engine.advance(10);
    engine
        .ingest(
            1,
            crate::engine::Segment {
                id: "current".into(),
                at_ms: 10,
                speaker: "Adrian".into(),
                text: "Should we plan setup for half eight?".into(),
            },
        )
        .unwrap();
    let request = read(&mut reader, &mut stream);
    assert_eq!(request["type"], "evaluate");
    assert_eq!(request["input"]["priorNotes"][0]["text"], item.excerpt);
    assert_eq!(request["scope"], ack["scope"]);
    let authority =
        crate::selected_attestation::read(&f.settings.attested.as_ref().unwrap().0).unwrap();
    assert_eq!(
        authority
            .commitment(&proof, &request["input"]["priorNotes"])
            .unwrap(),
        proof.commitment
    );
    engine.revoke_processing();
    assert!(!link.scope_ready());
    assert!(engine.audio_approval(1).is_none());
    let cancel = read(&mut reader, &mut stream);
    assert_eq!(cancel["type"], "cancel");
}
#[test]
fn attested_pending_and_ready_scope_cannot_survive_source_removal_revoke_or_stop() {
    for ready in [false, true] {
        for control in ["remove", "revoke", "stop"] {
            let f = attested_fixture(1);
            let (mut e, link, item) = attested_engine(&f);
            let review = e
                .review_processing(
                    crate::engine::ConversationScope::NewSpeechOnly,
                    &[(item.provider, item.source_id, item.revision)],
                )
                .unwrap();
            e.approve_processing(review).unwrap();
            let (mut stream, mut reader, mut grant) = accept_attested_scope(&f, 1);
            if ready {
                grant["type"] = json!("scope_ready");
                write_frame(&mut stream, &grant).unwrap();
                assert_eq!(read(&mut reader, &mut stream)["type"], "scope_current");
                assert!(link.scope_ready());
            }
            match control {
                "remove" => e.set_notes(vec![]),
                "revoke" => e.revoke_processing(),
                _ => {
                    e.begin_live_stop();
                }
            }
            assert!(!link.scope_ready());
            assert!(e.audio_approval(1).is_none());
            assert!(link
                .scope
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|s| !s.current.load(Ordering::Acquire)));
            // Dropping the peer also retires any handshake/clock wait; no evaluator exists before speech.
            drop(stream);
        }
    }
}
#[test]
fn attested_control_zero_refuses_note_selection_and_approves_empty_without_audio_before_ready() {
    let f = attested_fixture(0);
    let (mut e, link, item) = attested_engine(&f);
    assert!(e
        .review_processing(
            crate::engine::ConversationScope::NewSpeechOnly,
            &[(item.provider, item.source_id, item.revision)]
        )
        .is_err());
    let review = e
        .review_processing(crate::engine::ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    e.approve_processing(review).unwrap();
    assert!(!link.scope_ready());
    assert!(e.audio_approval(1).is_none());
    e.revoke_processing();
}

#[test]
fn descriptor_accepts_canonical_paths_under_a_symlinked_root_and_rejects_mixed_spellings() {
    // Mirrors macOS /var -> /private/var: one real run directory reached
    // through a symlinked root. The broker now writes canonical paths.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let base = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "tq-root-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(base.clone());
    let real = base.join("real");
    let alias = base.join("alias");
    fs::create_dir_all(&real).unwrap();
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let run = real.join("run");
    fs::create_dir(&run).unwrap();
    fs::set_permissions(&run, fs::Permissions::from_mode(0o700)).unwrap();
    let canonical_run = run.canonicalize().unwrap();
    let aliased_run = alias.join("run");
    assert_eq!(canonical_run, run);
    assert_ne!(aliased_run, canonical_run);
    assert_eq!(aliased_run.canonicalize().unwrap(), canonical_run);

    let socket = canonical_run.join("s");
    let listener = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    let write = |socket_path: &PathBuf| {
        let path = canonical_run.join("d");
        let _ = fs::remove_file(&path);
        fs::write(&path, json!({"schema":"talkqte.lab.descriptor.v1","runId":"fictional-run","socketPath":socket_path,"nonce":"a".repeat(64)}).to_string()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    };
    let settings = |descriptor: PathBuf| Settings {
        bounded_history: false,
        backend: Backend::Subscription,
        spend_cap_micro_usd: None,
        selected_prior: false,
        attested: None,
        descriptor,
        provider: "codex".into(),
        model: "gpt-6.1-sol".into(),
        effort: "medium".into(),
    };
    let canonical = settings(canonical_run.join("d"));
    let aliased = settings(aliased_run.join("d"));

    // Canonical descriptor and canonical socket: accepted, and the
    // listener is reachable at the accepted path.
    write(&socket);
    let d = descriptor(&canonical).expect("canonical pair accepted");
    assert_eq!(d.socket_path, socket);
    let _client = UnixStream::connect(&d.socket_path).unwrap();
    listener.accept().unwrap();

    // RunB01 shape: launcher-canonical socket, noncanonical descriptor.
    assert_eq!(descriptor(&aliased).err(), Some(Failure::InvalidInput));
    // The reverse mismatch is rejected too.
    write(&aliased_run.join("s"));
    assert_eq!(descriptor(&canonical).err(), Some(Failure::InvalidInput));
    // The invariant is lexical: one consistent spelling is still accepted.
    assert!(descriptor(&aliased).is_ok());
}

fn context_settings(context: Option<&str>, subscription: bool) -> Result<Settings, Failure> {
    Settings::parse(|key| {
        match key {
            "TALKQTE_DEV_CUE_BACKEND" => Some(if subscription {
                "lab-subscription"
            } else {
                "lab-api"
            }),
            "TALKQTE_DEV_LAB_DESCRIPTOR" => Some("/fictional/private/descriptor"),
            "TALKQTE_DEV_LAB_PROVIDER" => Some(if subscription {
                "codex"
            } else {
                "anthropic-api"
            }),
            "TALKQTE_DEV_LAB_MODEL" => Some(if subscription {
                "gpt-6.1-sol"
            } else {
                "claude-opus-5-5"
            }),
            "TALKQTE_DEV_LAB_EFFORT" => Some("low"),
            "TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD" => {
                if subscription {
                    None
                } else {
                    Some("250000")
                }
            }
            "TALKQTE_DEV_LAB_CONTEXT" => context,
            _ => None,
        }
        .map(str::to_string)
    })
}

#[test]
fn lab_context_requires_exact_explicit_api_selection_and_defaults_to_fresh() {
    assert!(!context_settings(None, false).unwrap().bounded_history);
    assert!(!context_settings(None, true).unwrap().bounded_history);
    assert!(
        context_settings(Some("bounded-history"), false)
            .unwrap()
            .bounded_history
    );
    assert!(context_settings(Some("bounded-history"), true).is_err());
    let history = context_settings(Some("bounded-history"), false).unwrap();
    assert!(!history.selected_prior);
    assert!(history.attested.is_none());
    let selected = context_settings(Some(SELECTED_CONTEXT), false).unwrap();
    assert!(!selected.bounded_history);
    assert!(selected.selected_prior);
    for value in [
        "bounded-history,selected-prior-v2",
        "selected-prior-v2,bounded-history",
        "",
        "fresh-only",
        "on",
        "bounded-history ",
        "BOUNDED-HISTORY",
        "unknown",
    ] {
        assert!(
            context_settings(Some(value), false).is_err(),
            "invalid context must not fall back"
        );
    }
}

#[test]
fn lab_history_disclosure_retains_api_audio_cost_and_expanded_scope_before_approval() {
    for mode in [None, Some("bounded-history")] {
        let settings = context_settings(mode, false).unwrap();
        let p = processor_configuration(
            Backend::Api,
            Some(&settings),
            Some("Fictional audio is sent to the reviewed transcription service.".into()),
            Some("Fictional transcription service".into()),
        )
        .unwrap();
        let summary = crate::engine::ProcessorSummary::from(&p);
        assert_eq!(
            summary.audio_destination.as_deref(),
            Some("Fictional transcription service")
        );
        assert!(summary.data_policy.contains("Anthropic API"));
        assert!(summary.data_policy.contains("$0.25"));
        assert!(summary.data_policy.contains("Fictional audio is sent"));
        assert!(!summary.accepts_notes);
        assert_eq!(summary.data_policy.contains("24 segments"), mode.is_some());
        if mode.is_some() {
            assert!(summary.data_policy.contains("90 seconds"));
            assert!(summary.data_policy.contains("16384-byte"));
            assert!(summary
                .data_policy
                .contains("Visible cue evidence may be older"));
        }
    }
}

#[test]
fn lab_history_rejects_unrepresentable_disclosure_instead_of_omitting_it() {
    let settings = context_settings(Some("bounded-history"), false).unwrap();
    assert!(
        processor_configuration(Backend::Api, Some(&settings), Some("x".repeat(2048)), None)
            .is_err()
    );
}

#[test]
fn lab_history_opaque_review_cancel_replay_and_legacy_grant_never_dispatch() {
    use crate::engine::{ConversationScope, ProcessingError};
    struct Fictional(std::sync::mpsc::Sender<Request>);
    impl Evaluator for Fictional {
        fn evaluate(&mut self, r: &Request, _: &Cancellation) -> Result<String, Failure> {
            self.0.send(r.clone()).unwrap();
            Ok(
                json!({"action":"quiet","cue":null,"sourceIds":[r.sources().last().unwrap().id]})
                    .to_string(),
            )
        }
    }
    let settings = context_settings(Some("bounded-history"), false).unwrap();
    let processor = processor_configuration(Backend::Api, Some(&settings), None, None).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let mut engine = Engine::live_with_evaluator(
        Worker::start(Fictional(tx), Duration::from_secs(2)).unwrap(),
        processor,
    );
    engine.start().unwrap();
    engine.advance(1000);
    engine
        .ingest(
            engine.session(),
            crate::engine::Segment {
                id: "old".into(),
                at_ms: 1000,
                speaker: "Speaker".into(),
                text: "Earlier workshop detail.".into(),
            },
        )
        .unwrap();
    assert!(
        rx.try_recv().is_err(),
        "selecting history does not approve processing"
    );
    let review = engine
        .review_processing(ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    assert_eq!(
        engine.approve_processing_with_origin(review, true),
        Err(ProcessingError::InvalidScope)
    );
    assert!(!engine.has_processing_permission());
    let mut reviews = crate::processing_reviews::Reviews::default();
    let cancelled = reviews
        .prepare(&engine, ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    assert!(reviews.cancel(&cancelled));
    assert_eq!(
        reviews.approve(&mut engine, &cancelled),
        Err(ProcessingError::StaleReview)
    );
    assert!(rx.try_recv().is_err());
    let id = reviews
        .prepare(&engine, ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    reviews.approve(&mut engine, &id).unwrap();
    assert!(engine.has_processing_permission());
    assert_eq!(
        reviews.approve(&mut engine, &id),
        Err(ProcessingError::StaleReview)
    );
    assert!(
        rx.try_recv().is_err(),
        "new-only review must not send buffered history"
    );
    engine.advance(10);
    engine
        .ingest(
            engine.session(),
            crate::engine::Segment {
                id: "new".into(),
                at_ms: 1010,
                speaker: "Speaker".into(),
                text: "New workshop detail.".into(),
            },
        )
        .unwrap();
    let request = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(request.sources().len(), 1);
    assert_eq!(request.sources()[0].id, "transcript:new");
    engine.revoke_processing();
    assert!(!engine.has_processing_permission());
    assert_eq!(
        reviews.approve(&mut engine, &id),
        Err(ProcessingError::StaleReview)
    );
}

// Ordinary public v2 only: this is not an attested-scope handshake or runtime IPC.
#[test]
fn ordinary_selected_shared_lifecycle_cases_cancel_real_link_and_reject_late_reply() {
    use crate::engine::{ConversationScope, Segment};
    let cases: Value = serde_json::from_str(include_str!(
        "../../scripts/fixtures/selected-context-lifecycle.json"
    ))
    .unwrap();
    assert_eq!(cases["schema"], "talkqte.lab.selected.lifecycle-cases.v1");
    for case in cases["cases"].as_array().unwrap() {
        let count = case["noteCount"].as_u64().unwrap();
        assert!(count <= 1);
        let mut f = Fixture::new();
        let path = f.settings.descriptor.clone();
        f.settings = selected_settings();
        f.settings.descriptor = path.clone();
        assert!(f.settings.attested.is_none());
        let mut descriptor: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        descriptor["schema"] = json!("talkqte.lab.selected.descriptor.v2");
        fs::write(&path, descriptor.to_string()).unwrap();
        let link = f.link(Some(ClockSample {
            session_id: 1,
            elapsed_ms: 10,
        }));
        let processor =
            processor_configuration(Backend::Api, Some(&f.settings), None, None).unwrap();
        assert_eq!(
            crate::engine::ProcessorSummary::from(&processor).required_note_count,
            None
        );
        let mut engine = Engine::live_with_evaluator(
            Worker::start(Adapter(link.clone()), DEADLINE).unwrap(),
            processor,
        )
        .with_lab_lifecycle(link.clone());
        engine.start().unwrap();
        let note = crate::context::ContextItem {
            provider: crate::context::Provider::File,
            source_id: "fixture-note".into(),
            title: "Fictional workshop".into(),
            source_date: "2026-10-20".into(),
            excerpt: "The room cannot open before nine.".into(),
            revision: 1,
        };
        engine.set_notes(vec![note.clone()]);
        let selected = if count == 0 {
            vec![]
        } else {
            vec![(note.provider, note.source_id.clone(), note.revision)]
        };
        let review = engine
            .review_processing(ConversationScope::NewSpeechOnly, &selected)
            .unwrap();
        assert!(!engine.has_processing_permission());
        engine.approve_processing(review).unwrap();
        engine.advance(10);
        engine
            .ingest(
                1,
                Segment {
                    id: "current".into(),
                    at_ms: 10,
                    speaker: "Maya".into(),
                    text: "Can we open the room at nine?".into(),
                },
            )
            .unwrap();
        let mut stream = f.accept();
        let mut reader = Reader::default();
        let hello = read(&mut reader, &mut stream);
        assert_eq!(hello["schema"], SELECTED_SCHEMA);
        assert_eq!(hello["contextPolicy"], SELECTED_CONTEXT);
        assert!(hello.get("scope").is_none());
        let mut ready = f.settings.frame("ready", "fictional-run", 1);
        ready
            .as_object_mut()
            .unwrap()
            .extend(f.settings.identity().as_object().unwrap().clone());
        ready.as_object_mut().unwrap().extend(json!({"provider":"anthropic-api","model":"claude-opus-5-5","effort":"low","dispatchBudgetKind":"apiRequests","dispatchLimit":40,"dispatchesUsed":0,"spendCapMicroUsd":1000000,"spendUsedMicroUsd":0}).as_object().unwrap().clone());
        write_frame(&mut stream, &ready).unwrap();
        let mut probe = f.settings.frame("clock_probe", "fictional-run", 1);
        probe["probeId"] = json!("ordinary-lifecycle");
        write_frame(&mut stream, &probe).unwrap();
        assert_eq!(read(&mut reader, &mut stream)["type"], "clock_sample");
        let request = read(&mut reader, &mut stream);
        assert_eq!(request["type"], "evaluate");
        assert_eq!(
            request["input"]["priorNotes"].as_array().unwrap().len() as u64,
            count,
            "{}",
            case["id"]
        );
        assert!(request.get("scope").is_none());
        match case["control"].as_str().unwrap() {
            "revoke" => engine.revoke_processing(),
            "remove" => {
                assert_eq!(count, 1);
                engine.set_notes(vec![]);
            }
            "stop" => {
                // Engine eligibility retirement is distinct from the host hook below.
                assert_eq!(case["boundary"], "engine");
                engine.begin_live_stop();
            }
            "host-stop" => {
                assert_eq!(case["boundary"], "host-link-stop");
                link.cancel_reason(ControlReason::Stop);
                engine.begin_live_stop();
            }
            _ => panic!("unknown fictional lifecycle control"),
        }
        assert!(!engine.has_processing_permission());
        let cancel = read(&mut reader, &mut stream);
        assert_eq!(cancel["type"], "cancel");
        assert_eq!(cancel["reason"], case["cancelReason"]);
        let mut late = f.settings.frame("result", "fictional-run", 1);
        late["requestId"] = request["requestId"].clone();
        late["contextRevision"] = request["contextRevision"].clone();
        late["elapsedMs"] = json!(1);
        late["value"] = json!({
            "action": "show",
            "cue": "Should we check the opening time?",
            "sourceIds": [request["input"]["events"][0]["id"].clone()]
        });
        let _ = write_frame(&mut stream, &late);
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(2));
            engine.advance(1);
        }
        assert!(engine.state.cue.is_none(), "{}", case["id"]);
        assert!(!engine.has_processing_permission());
        assert!(link.terminal().is_some());
    }
}

use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command, Stdio};
struct PairedJsPeer {
    child: Child,
    input: ChildStdin,
    frames: Receiver<Value>,
    worker: Option<i32>,
    descriptor: Option<PathBuf>,
    done: bool,
    home: PathBuf,
}
impl PairedJsPeer {
    fn start(context: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let home = std::env::temp_dir().join(format!(
            "tq-pair-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fixtures/paired-selected-broker.mjs");
        let mut command = Command::new("node");
        command
            .args(["--no-warnings", "--experimental-test-module-mocks"])
            .arg(script)
            .arg(context)
            .env_clear()
            .env("HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        for key in ["PATH", "TMPDIR", "LANG"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .spawn()
            .expect("Node22 and committed npm dependencies required");
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (send, frames) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let line = line.unwrap();
                let value = serde_json::from_str(&line)
                    .unwrap_or_else(|_| panic!("invalid paired test control: {line}"));
                if send.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            frames,
            worker: None,
            descriptor: None,
            done: false,
            home,
        }
    }
    fn next(&mut self, kind: &str) -> Value {
        let until = Instant::now() + Duration::from_secs(6);
        loop {
            let frame = self
                .frames
                .recv_timeout(until.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|e| panic!("missing paired {kind}: {e}"));
            if frame["type"] == "worker-started" {
                self.worker = Some(frame["workerPid"].as_i64().unwrap() as i32);
                continue;
            }
            assert_eq!(frame["type"], kind, "{frame}");
            if kind == "descriptor" {
                let path = PathBuf::from(frame["path"].as_str().unwrap());
                assert_eq!(path.file_name().unwrap(), "descriptor.json");
                let parent = path.parent().unwrap();
                assert!(parent
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("tq-lab-"));
                assert!(parent.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
                self.descriptor = Some(path);
            }
            return frame;
        }
    }
    fn send(&mut self, kind: &str) {
        writeln!(self.input, "{}", json!({"type":kind})).unwrap();
        self.input.flush().unwrap();
    }
    fn finish(&mut self) -> Value {
        self.send("finish");
        let done = self.next("done");
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "paired Node fixture failed");
                break;
            }
            assert!(Instant::now() < until, "paired fixture did not exit");
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(done["descriptorRemoved"], true);
        assert_eq!(done["workerGone"], true);
        self.done = true;
        done
    }
}
impl Drop for PairedJsPeer {
    fn drop(&mut self) {
        if !self.done {
            let _ = writeln!(self.input, "{}", json!({"type":"finish"}));
            let until = Instant::now() + Duration::from_secs(2);
            while Instant::now() < until {
                if self.child.try_wait().ok().flatten().is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
            if let Some(pid) = self.worker {
                // Only the owned worker group reported by this fixture.
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
            if self.child.try_wait().ok().flatten().is_none() {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
        }
        if let Some(path) = &self.descriptor {
            let _ = fs::remove_dir_all(path.parent().unwrap());
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}

// Actual cross-process public ordinary-v2 pairing. The SDK alone is fake;
// Engine, evaluator Worker/Link, Unix broker, provider adapter and API worker run.
#[test]
fn ordinary_selected_pairs_with_public_js_worker_and_retires_late_delivery() {
    use crate::engine::{ConversationScope, Segment};
    for (count, control) in [
        (0, "accept"),
        (1, "accept"),
        (1, "revoke"),
        (0, "engine-stop"),
        (1, "host-stop"),
    ] {
        eprintln!("paired case notes={count} control={control}");
        let mut peer = PairedJsPeer::start("selected-prior-v2");
        let descriptor = peer.next("descriptor");
        assert_eq!(descriptor["sdkMocked"], true);
        let mut settings = selected_settings();
        assert!(settings.attested.is_none());
        settings.descriptor = PathBuf::from(descriptor["path"].as_str().unwrap());
        let link = Link::new(
            settings.clone(),
            Arc::new(Mutex::new(Some(Arc::new(|| {
                Some(ClockSample {
                    session_id: 1,
                    elapsed_ms: 10,
                })
            })))),
            Arc::new(AtomicBool::new(false)),
        );
        let processor = processor_configuration(Backend::Api, Some(&settings), None, None).unwrap();
        let mut engine = Engine::live_with_evaluator(
            Worker::start(Adapter(link.clone()), DEADLINE).unwrap(),
            processor,
        )
        .with_lab_lifecycle(link.clone());
        engine.start().unwrap();
        let note = crate::context::ContextItem {
            provider: crate::context::Provider::File,
            source_id: "fixture-note".into(),
            title: "Fictional workshop".into(),
            source_date: "2026-10-20".into(),
            excerpt: "The room cannot open before nine.".into(),
            revision: 1,
        };
        engine.set_notes(vec![note.clone()]);
        let selected = if count == 0 {
            vec![]
        } else {
            vec![(note.provider, note.source_id.clone(), note.revision)]
        };
        let review = engine
            .review_processing(ConversationScope::NewSpeechOnly, &selected)
            .unwrap();
        assert!(!engine.has_processing_permission());
        engine.approve_processing(review).unwrap();
        engine.advance(10);
        engine
            .ingest(
                1,
                Segment {
                    id: "current".into(),
                    at_ms: 10,
                    speaker: "Maya".into(),
                    text: "Can we open the room at nine?".into(),
                },
            )
            .unwrap();
        peer.next("calibrated");
        let requested = peer.next("sdk-request");
        let identity = &requested["nativeIdentity"];
        assert_eq!(identity["sessionId"], "1");
        assert_ne!(identity["requestId"], "0");
        assert_eq!(
            requested["input"]["priorNotes"].as_array().unwrap().len(),
            count
        );
        assert_eq!(requested["input"]["events"][0]["id"], "transcript:current");
        if count == 1 {
            assert_eq!(requested["input"]["priorNotes"][0]["text"], note.excerpt);
        }
        match control {
            "accept" => {}
            "revoke" => engine.revoke_processing(),
            "engine-stop" => {
                engine.begin_live_stop();
            }
            "host-stop" => {
                link.cancel_reason(ControlReason::Stop);
                engine.begin_live_stop();
            }
            _ => unreachable!(),
        }
        if control != "accept" {
            assert!(!engine.has_processing_permission());
            assert_eq!(peer.next("sdk-aborted")["id"], requested["id"]);
        }
        peer.send("release");
        let released = peer.next("sdk-released");
        assert_eq!(released["afterAbort"], control != "accept");
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            engine.advance(1);
            if control == "accept" && engine.state.cue.is_some() {
                break;
            }
            if control != "accept" && link.terminal().is_some() {
                break;
            }
            assert!(
                Instant::now() < until,
                "paired delivery did not settle: {count}/{control}"
            );
            thread::sleep(Duration::from_millis(2));
        }
        if control == "accept" {
            let cue = engine.state.cue.as_ref().unwrap();
            assert_eq!(cue.question, "Should we check the opening time?");
            assert_eq!(cue.sources.len(), count + 1);
            let (request, _) = engine.lab_cue_metadata(&cue.id).expect("actual model cue");
            assert_eq!(request.to_string(), identity["requestId"].as_str().unwrap());
            engine.revoke_processing();
        }
        let done = peer.finish();
        let native: Vec<_> = done["frames"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["type"] == "evaluate")
            .collect();
        assert_eq!(native.len(), 1);
        assert!(native[0].get("scope").is_none());
        assert_eq!(native[0]["contextRevision"], identity["contextRevision"]);
        assert_eq!(done["summary"]["dispatched"], 1);
        assert_eq!(done["resultsSent"], if control == "accept" { 1 } else { 0 });
        let reason = if control == "host-stop" {
            "stop"
        } else {
            "eligibility_change"
        };
        if control != "accept" {
            assert!(
                done["frames"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["type"] == "cancel" && f["reason"] == reason),
                "{done}"
            );
        }
        // Recheck after both JS processes and the socket descriptor are retired.
        engine.advance(1);
        assert!(engine.state.cue.is_none());
        assert!(!engine.has_processing_permission());
    }
}

// Transcript availability and permission only; the fake reply judges no facts.
#[test]
fn bounded_history_pairs_with_public_js_without_old_only_or_note_dispatch() {
    use crate::engine::{ConversationScope, EvaluationStatus, ProcessingError, Segment};
    for (history, scope, includes_old) in [
        (true, ConversationScope::RecentAndNewSpeech, true),
        (false, ConversationScope::RecentAndNewSpeech, false),
        (true, ConversationScope::NewSpeechOnly, false),
    ] {
        eprintln!("paired history={history} scope={scope:?} old_included={includes_old}");
        // As in the production run router, both transcript modes use the
        // ordinary fresh-only JS wire. Expanded native review owns history.
        let mut peer = PairedJsPeer::start("fresh-only");
        let descriptor = peer.next("descriptor");
        let mut settings = api_settings(Some("1000000"), "claude-opus-5-5", "low").unwrap();
        settings.bounded_history = history;
        settings.descriptor = PathBuf::from(descriptor["path"].as_str().unwrap());
        assert!(!settings.selected_prior && settings.attested.is_none());
        let link = Link::new(
            settings.clone(),
            Arc::new(Mutex::new(Some(Arc::new(|| {
                Some(ClockSample {
                    session_id: 1,
                    elapsed_ms: 40_002,
                })
            })))),
            Arc::new(AtomicBool::new(false)),
        );
        let processor = processor_configuration(Backend::Api, Some(&settings), None, None).unwrap();
        let summary = crate::engine::ProcessorSummary::from(&processor);
        assert!(!summary.accepts_notes);
        assert_eq!(summary.data_policy.contains("24 segments"), history);
        if history {
            assert!(summary.data_policy.contains("90 seconds"));
            assert!(summary.data_policy.contains("16384-byte"));
        }
        let mut engine = Engine::live_with_evaluator(
            Worker::start(Adapter(link.clone()), DEADLINE).unwrap(),
            processor,
        )
        .with_lab_lifecycle(link.clone());
        engine.start().unwrap();
        engine.advance(1_000);
        let old_fact = "The fictional hall entrance is on the south side.";
        engine
            .ingest(
                1,
                Segment {
                    id: "history-old".into(),
                    at_ms: 1_000,
                    speaker: "Maya".into(),
                    text: old_fact.into(),
                },
            )
            .unwrap();
        engine.advance(39_000);
        let note = crate::context::ContextItem {
            provider: crate::context::Provider::File,
            source_id: "history-must-not-use".into(),
            title: "Fictional venue note".into(),
            source_date: "2026-10-20".into(),
            excerpt: "A note outside transcript approval.".into(),
            revision: 1,
        };
        engine.set_notes(vec![note.clone()]);
        assert!(!engine.has_processing_permission());
        assert_eq!(
            engine
                .review_processing(
                    scope,
                    &[(note.provider, note.source_id.clone(), note.revision)]
                )
                .err(),
            Some(ProcessingError::InvalidScope)
        );
        let review = engine.review_processing(scope, &[]).unwrap();
        engine.approve_processing(review).unwrap();
        assert!(engine.has_processing_permission());
        // Approval may submit recent speech, but this line is39s old. The
        // synchronous engine state proves none was queued, without a sleep.
        assert_eq!(engine.evaluation_status(), Some(EvaluationStatus::Idle));
        assert!(!link.started.load(Ordering::Acquire));
        peer.send("status");
        let idle = peer.next("status");
        assert_eq!(idle["dispatched"], 0);
        assert_eq!(idle["evaluations"], 0);
        engine.advance(2);
        engine
            .ingest(
                1,
                Segment {
                    id: "history-anchor".into(),
                    at_ms: 40_002,
                    speaker: "Maya".into(),
                    text: "We are checking the fictional venue setup now.".into(),
                },
            )
            .unwrap();
        peer.next("calibrated");
        let requested = peer.next("sdk-request");
        let input = &requested["input"];
        assert!(input.get("priorNotes").is_none());
        assert!(input.get("inputContract").is_none());
        let events = input["events"].as_array().unwrap();
        let ids: Vec<_> = events
            .iter()
            .map(|event| event["id"].as_str().unwrap())
            .collect();
        if includes_old {
            assert_eq!(ids, ["transcript:history-old", "transcript:history-anchor"]);
            assert_eq!(events[0]["text"], old_fact);
        } else {
            assert_eq!(ids, ["transcript:history-anchor"]);
        }
        peer.send("release");
        assert_eq!(peer.next("sdk-released")["afterAbort"], false);
        let until = Instant::now() + Duration::from_secs(3);
        while engine.state.cue.is_none() {
            assert!(
                Instant::now() < until,
                "history fake delivery did not settle"
            );
            engine.advance(1);
            thread::sleep(Duration::from_millis(2));
        }
        let cue = engine.state.cue.as_ref().unwrap();
        assert_eq!(cue.sources.len(), 1);
        assert_eq!(cue.sources[0].id, "transcript:history-anchor");
        let (request, _) = engine.lab_cue_metadata(&cue.id).unwrap();
        assert_eq!(
            request.to_string(),
            requested["nativeIdentity"]["requestId"].as_str().unwrap()
        );
        engine.revoke_processing();
        let done = peer.finish();
        assert_eq!(done["resultsSent"], 1);
        assert_eq!(done["summary"]["dispatched"], 1);
        let evaluations: Vec<_> = done["frames"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|frame| frame["type"] == "evaluate")
            .collect();
        assert_eq!(evaluations.len(), 1);
        assert_eq!(
            evaluations[0]["contextRevision"],
            requested["nativeIdentity"]["contextRevision"]
        );
        assert!(evaluations[0].get("scope").is_none());
        assert!(!engine.has_processing_permission());
        assert!(engine.state.cue.is_none());
    }
}
