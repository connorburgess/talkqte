//! Offline Unix peers only: no provider process, app, audio or model calls.
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
