//! A scripted hour of a live session with both sources, on the session
//! clock, run in a few seconds: fictional lines from the microphone and an
//! application at a conversational rate, echoes through the speakers, cues
//! and dismissals, model cue requests to a scripted Anthropic transport, two
//! reconnects and the shared Deepgram budget. It checks that everything the
//! session grows stays bounded, that the caps are counted as documented, and
//! prints the numbers. No device, network, key or real meeting is involved.

use super::*;
use crate::engine::{Engine, LineOrigin, Response, Segment, SessionSources, ECHO_DROPPED};
use crate::transcription::cloud::Budget;

#[derive(Clone, Default)]
struct Quiet(Arc<Mutex<u64>>);

impl Transport for Quiet {
    fn post(&mut self, _: &Secret, body: &[u8], _: Duration) -> Result<Reply, NoReply> {
        *self.0.lock().unwrap() += 1;
        // A quiet decision cites the newest line it was sent.
        let sent = String::from_utf8_lossy(body);
        let cited = sent
            .match_indices("transcript:")
            .filter_map(|(at, _)| {
                let id: String = sent[at..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || ":-_.".contains(*c))
                    .collect();
                (id.len() > "transcript:".len()).then_some(id)
            })
            .last()
            .unwrap_or_default();
        // One reply in ten shows a cue, so cues are shown and dismissed too.
        let count = *self.0.lock().unwrap();
        let decision = if count.is_multiple_of(10) {
            json!({"action": "show", "cue": "Who will take the first draft?", "sourceIds": [cited]})
        } else {
            json!({"action": "quiet", "cue": null, "sourceIds": [cited]})
        }
        .to_string();
        let events = [
            json!({"type":"message_start","message":{"model":MODEL,"usage":{"input_tokens":1200,"cache_creation_input_tokens":0,"cache_read_input_tokens":2500,"output_tokens":1}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":decision}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}),
            json!({"type":"message_stop"}),
        ];
        let body: String = events
            .iter()
            .map(|event| {
                format!(
                    "event: {}\ndata: {event}\n\n",
                    event["type"].as_str().unwrap()
                )
            })
            .collect();
        Ok(Reply {
            status: 200,
            body: Box::new(std::io::Cursor::new(body.into_bytes())),
        })
    }
}

/// Fictional things people say in a planning call, by both sides.
const SAID: [&str; 12] = [
    "The fictional garden shed needs a new roof before spring.",
    "We could ask the hardware shop about the timber prices.",
    "I think the volunteers meet on the second Saturday.",
    "The newsletter goes out once the photos are ready.",
    "Let's keep the budget for paint under the agreed amount.",
    "The compost bins are full again after the harvest.",
    "Somebody mentioned a grant for community spaces.",
    "The gate lock sticks whenever it rains a lot.",
    "We still have the leaflets from the summer fair.",
    "The school wants to visit with two classes in May.",
    "I can bring the folding tables from the hall.",
    "The water butt by the greenhouse is leaking slowly.",
];
/// A line the phrase rules raise a cue for.
const OWNER: &str = "Someone can take the first draft of the welcome guide.";

const HOUR_MS: u64 = 60 * 60 * 1_000;
/// One second of session clock per step; each source spends one second of
/// audio from the shared budget per step.
const TICK_MS: u64 = 1_000;

#[test]
fn an_hour_with_both_sources_stays_bounded_and_counts_its_caps() {
    let transport = Quiet::default();
    let usage = Arc::new(Usage::default());
    let adapter = AnthropicApi::new(
        model(MODEL).unwrap(),
        transport.clone(),
        Box::new(|| {
            Ok(Secret::for_test(
                "sk-ant-api03-FICTIONALsustained0123456789abcdef",
            ))
        }),
        Box::new(|| {}),
        usage.clone(),
    );
    let mut e: Engine = registered(adapter, model(MODEL).unwrap(), None);
    e.start().unwrap();
    e.set_sources(SessionSources::both(("Fictional Call", "fictional-call")));
    let session = e.session();
    e.application_attached(session);
    // As a launch with Deepgram selected sets it; tests select none.
    e.state.transcription = Some(crate::engine::CloudTranscription {
        provider: "Deepgram".into(),
        stopped: None,
        dropped_audio: false,
        reconnects: 0,
        lost_ms: 0,
        minutes_left: None,
    });
    let review = e
        .review_processing(crate::engine::ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    e.approve_processing(review).unwrap();

    // The person's-key budget, shared by both streams as in a real session.
    let budget = Budget::new(Duration::from_secs(
        u64::from(crate::transcription::cloud::OWN_KEY_MINUTE_CAP) * 60,
    ));
    let frame = crate::transcription::SAMPLE_RATE as u64;
    let mut cap_reached_ms = None;
    let mut warned = Vec::new();
    let mut request_cap_ms = None;
    let (mut accepted, mut echoes, mut cues, mut last_cue) = (0usize, 0u32, 0usize, None);
    let (mut app, mut mic) = (0u64, 0u64);
    let mut last_app_text = SAID[0];
    let mut peak = crate::engine::Growth::default();

    let mut now = 0;
    while now < HOUR_MS {
        now += TICK_MS;
        e.advance(TICK_MS);
        // Each source sends its second of audio while transcription runs.
        if cap_reached_ms.is_none() {
            budget.reserve(frame);
            budget.reserve(frame);
            if budget.left().is_zero() {
                cap_reached_ms = Some(now);
            }
        }
        e.cloud_transcription_left(session, budget.left());
        let left = e
            .state
            .transcription
            .as_ref()
            .and_then(|transcription| transcription.minutes_left);
        if left.is_some() && warned.last() != Some(&left) {
            warned.push(left);
        }
        // The other side speaks every 5 s, the person every 7 s; one line in
        // eight from the microphone is the call heard through the speakers.
        if now.is_multiple_of(5_000) {
            app += 1;
            last_app_text = SAID[(app as usize * 5) % SAID.len()];
            let line = Segment {
                id: format!("a{app}"),
                at_ms: now - 400,
                speaker: "Speaker".into(),
                speaker_id: None,
                text: last_app_text.into(),
            };
            e.ingest_from(session, LineOrigin::Application, line)
                .unwrap();
            accepted += 1;
        }
        if now.is_multiple_of(7_000) {
            mic += 1;
            let text = if mic.is_multiple_of(8) {
                last_app_text
            } else if mic.is_multiple_of(13) {
                OWNER
            } else {
                SAID[(mic as usize * 7) % SAID.len()]
            };
            let line = Segment {
                id: format!("m{mic}"),
                at_ms: now - 300,
                speaker: "Speaker".into(),
                speaker_id: None,
                text: text.into(),
            };
            match e.ingest_from(session, LineOrigin::Microphone, line) {
                Ok(()) => accepted += 1,
                Err(error) if error == ECHO_DROPPED => echoes += 1,
                Err(error) => panic!("line refused: {error}"),
            }
        }
        // Two connection problems, as the feed reports them.
        if now == 20 * 60_000 || now == 40 * 60_000 {
            e.cloud_transcription_reconnected(session, 3_000);
        }
        // A cue is counted once; every other one is dismissed.
        if let Some(cue) = e.state.cue.clone() {
            if last_cue.as_ref() != Some(&cue.id) {
                cues += 1;
                last_cue = Some(cue.id.clone());
                if cues.is_multiple_of(2) {
                    e.respond(&cue.id, Response::Dismiss).unwrap();
                }
            }
        }
        // Let a request in flight settle before the clock moves on.
        for _ in 0..500 {
            if e.evaluation_status() != Some(crate::engine::EvaluationStatus::Pending) {
                break;
            }
            std::thread::sleep(Duration::from_micros(200));
            // The engine reads a finished reply when its clock moves.
            e.advance(1);
        }
        if request_cap_ms.is_none()
            && serde_json::to_value(e.processing_issue()).unwrap() == "requestLimit"
        {
            request_cap_ms = Some(now);
        }
        // Measured every ten seconds: a snapshot is serialized to size it.
        if now % 10_000 != 0 {
            continue;
        }
        let growth = e.growth();
        peak = crate::engine::Growth {
            transcript: peak.transcript.max(growth.transcript),
            meeting: peak.meeting.max(growth.meeting),
            meeting_cut: peak.meeting_cut || growth.meeting_cut,
            echoes: peak.echoes.max(growth.echoes),
            echo_recent: peak.echo_recent.max(growth.echo_recent),
            shown_cues: peak.shown_cues.max(growth.shown_cues),
            asked_lines: peak.asked_lines.max(growth.asked_lines),
            dismissed_sources: peak.dismissed_sources.max(growth.dismissed_sources),
            last_shown: peak.last_shown.max(growth.last_shown),
            snapshot_bytes: peak.snapshot_bytes.max(growth.snapshot_bytes),
        };
    }
    let spent = usage.snapshot(model(MODEL).unwrap());
    eprintln!(
        "sustained hour: {accepted} lines accepted, {echoes} echoes, {cues} cues, \
         {} requests (cap {} reached at {:?} min), estimated spend {} micro-USD, \
         Deepgram cap reached at {:?} min, low-cap notices {warned:?}, peak {peak:?}",
        spent.requests,
        REQUEST_CAP,
        request_cap_ms.map(|ms| ms as f64 / 60_000.0),
        spent.spent_micro_usd,
        cap_reached_ms.map(|ms| ms as f64 / 60_000.0),
    );

    // What the session grows stays within its bounds over the hour.
    assert!(peak.transcript <= 400);
    assert_eq!(
        peak.transcript, 400,
        "an hour is longer than the shown lines"
    );
    assert!(peak.echo_recent <= 16);
    assert!(peak.echoes <= 200);
    assert!(peak.shown_cues <= cues.min(1_000));
    assert!(peak.asked_lines <= 2 * cues + 2);
    assert!(peak.dismissed_sources <= cues);
    assert!(peak.last_shown <= 16, "one entry per question type");
    // Every snapshot carries the shown lines only, so its size stays flat
    // however long the meeting runs.
    assert!(peak.snapshot_bytes < 128 * 1024, "{}", peak.snapshot_bytes);
    // The whole meeting is kept for export and notes, not only the shown
    // part: nothing of the start is lost in an hour.
    assert_eq!(peak.meeting, accepted);
    assert!(!peak.meeting_cut);
    assert!(accepted > 400);
    e.set_keep_meeting(true);
    let kept = e.markdown();
    assert!(
        kept.contains(&format!("- 00:04 Them: {}", SAID[5])),
        "the first line is kept"
    );
    assert!(!kept.contains("start of this meeting is not included"));
    let plan = e.meeting_notes_plan(false);
    assert!(plan.is_err(), "notes wait for the end of the meeting");

    // The caps count as documented: two streams spend the 120 minutes in
    // one hour, and the notebook says so from ten minutes of meeting left.
    assert_eq!(
        cap_reached_ms,
        Some(HOUR_MS),
        "two streams, one 120-minute budget"
    );
    assert_eq!(warned.first(), Some(&Some(10)));
    assert_eq!(warned.last(), Some(&Some(0)));
    assert!(
        warned.windows(2).all(|pair| pair[0] > pair[1]),
        "{warned:?}"
    );
    // Requests: one at a time, at least two seconds apart, never past the
    // cap; the request cap, not the spend estimate, is what ends cues.
    assert!(spent.requests <= REQUEST_CAP);
    assert_eq!(*transport.0.lock().unwrap(), spent.requests);
    assert!(spent.spent_micro_usd <= SPEND_CAP_MICRO_USD);
    assert!(
        request_cap_ms.is_some(),
        "cues stop at the request cap within the hour"
    );
    // Reconnects are reported; nothing stopped the transcript.
    let transcription = e.state.transcription.clone().unwrap();
    assert_eq!(transcription.reconnects, 2);
    assert_eq!(transcription.stopped, None);
    assert_eq!(e.state.sources.as_ref().unwrap().echo_dropped, echoes);
}

#[test]
fn a_meeting_past_what_is_kept_says_its_start_is_missing_and_writes_no_partial_notes() {
    let mut e = Engine::live();
    e.start().unwrap();
    let session = e.session();
    for n in 0..4_100u64 {
        e.advance(1_000);
        e.ingest(
            session,
            Segment {
                id: format!("m{n}"),
                at_ms: e.state.elapsed_ms - 200,
                speaker: "Speaker".into(),
                speaker_id: None,
                text: format!("Fictional line number {n} about the garden rota."),
            },
        )
        .unwrap();
    }
    let growth = e.growth();
    assert_eq!(growth.transcript, 400);
    assert_eq!(growth.meeting, 4_000);
    assert!(growth.meeting_cut);
    e.set_keep_meeting(true);
    let kept = e.markdown();
    assert!(kept.contains("The start of this meeting is not included"));
    assert!(!kept.contains("Fictional line number 99 about"));
    assert!(kept.contains("Fictional line number 100 about"));
    assert!(kept.contains("Fictional line number 4099 about"));
    e.end();
    assert_eq!(
        e.meeting_notes_plan(false).err(),
        Some(crate::meeting_notes::Refusal::TooLong)
    );
}
