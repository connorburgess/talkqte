//! Actual own-key adapters behind held, in-memory HTTP replies. No network,
//! credentials, capture, clock sleeps, or OS services are used.
use super::*;
use crate::{anthropic_api, gemini_api, llm_provider, openai_api, provider_keys::Secret};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct HeldResponse {
    entered: mpsc::Sender<()>,
    release: Option<mpsc::Receiver<()>>,
    status: u16,
}
impl HeldResponse {
    fn receive(&mut self) -> (u16, Box<dyn std::io::Read + Send>) {
        // Exercise both delays before response headers (401/403) and a body
        // read that crosses cancellation after headers arrived (Gemini 400).
        let body = r#"{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}}"#;
        let release = self.release.take().unwrap();
        if self.status == 400 {
            (
                self.status,
                Box::new(HeldBody {
                    entered: Some(self.entered.clone()),
                    release,
                    body: std::io::Cursor::new(body.as_bytes().to_vec()),
                }),
            )
        } else {
            self.entered.send(()).unwrap();
            release.recv_timeout(Duration::from_secs(5)).unwrap();
            (
                self.status,
                Box::new(std::io::Cursor::new(body.as_bytes().to_vec())),
            )
        }
    }
}
struct HeldBody {
    entered: Option<mpsc::Sender<()>>,
    release: mpsc::Receiver<()>,
    body: std::io::Cursor<Vec<u8>>,
}
impl std::io::Read for HeldBody {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        std::io::Read::read(&mut self.body, bytes)
    }
}
impl anthropic_api::Transport for HeldResponse {
    fn post(
        &mut self,
        _: &Secret,
        _: &[u8],
        _: Duration,
    ) -> Result<anthropic_api::Reply, anthropic_api::NoReply> {
        let (status, body) = self.receive();
        Ok(anthropic_api::Reply { status, body })
    }
}
impl openai_api::Transport for HeldResponse {
    fn post(
        &mut self,
        _: &Secret,
        _: &[u8],
        _: Duration,
    ) -> Result<llm_provider::Reply, llm_provider::NoReply> {
        let (status, body) = self.receive();
        Ok(llm_provider::Reply { status, body })
    }
}
impl gemini_api::Transport for HeldResponse {
    fn post(
        &mut self,
        _: &str,
        _: &Secret,
        _: &[u8],
        _: Duration,
    ) -> Result<llm_provider::Reply, llm_provider::NoReply> {
        let (status, body) = self.receive();
        Ok(llm_provider::Reply { status, body })
    }
}

struct Adapter {
    evaluator: Box<dyn Evaluator>,
    finished: Arc<std::sync::atomic::AtomicBool>,
}
impl Evaluator for Adapter {
    fn evaluate(&mut self, request: &Request, cancel: &Cancellation) -> Result<String, Failure> {
        let result = self.evaluator.evaluate(request, cancel);
        self.finished.store(true, Ordering::Release);
        result
    }
}
fn approved(engine: &mut Engine) {
    let review = engine
        .review_processing(ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    engine.approve_processing(review).unwrap();
}
fn engine(
    provider: &str,
    transport: HeldResponse,
    rejected: Arc<AtomicUsize>,
) -> (Engine, Arc<std::sync::atomic::AtomicBool>) {
    let key = Box::new(|| Ok(Secret::for_test("fictional-provider-key")));
    let on_rejected = Box::new(move || {
        rejected.fetch_add(1, Ordering::SeqCst);
    });
    let (kind, model_id) = match provider {
        "anthropic" => (llm_provider::CueProvider::Anthropic, "claude-haiku-5-5"),
        "openai" => (llm_provider::CueProvider::OpenAi, "gpt-5-mini"),
        "gemini" => (llm_provider::CueProvider::Gemini, "gemini-2.5-flash"),
        _ => unreachable!(),
    };
    let usage = Arc::new(llm_provider::CueUsageTracker::new(kind, model_id, false));
    let adapter: Box<dyn Evaluator> = match provider {
        "anthropic" => Box::new(anthropic_api::AnthropicApi::new(
            anthropic_api::model("claude-haiku-5-5").unwrap(),
            transport,
            key,
            on_rejected,
            Arc::new(anthropic_api::Usage::default()),
        )),
        "openai" => Box::new(openai_api::OpenAiApi::new(
            llm_provider::ResolvedModel::from_curated(
                llm_provider::curated_model(llm_provider::CueProvider::OpenAi, "gpt-5-mini")
                    .unwrap(),
            ),
            transport,
            key,
            on_rejected,
            usage,
        )),
        "gemini" => Box::new(gemini_api::GeminiApi::new(
            llm_provider::ResolvedModel::from_curated(
                llm_provider::curated_model(llm_provider::CueProvider::Gemini, "gemini-2.5-flash")
                    .unwrap(),
            ),
            transport,
            key,
            on_rejected,
            usage,
        )),
        _ => unreachable!(),
    };
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut processor = fictional_processor();
    processor.id = format!("{provider}-api");
    let mut engine = Engine::live_with_evaluator(
        Worker::start(
            Adapter {
                evaluator: adapter,
                finished: finished.clone(),
            },
            Duration::from_secs(10),
        )
        .unwrap(),
        processor,
    );
    engine.start().unwrap();
    approved(&mut engine);
    (engine, finished)
}
fn speech(engine: &mut Engine) {
    engine.advance(10);
    engine
        .ingest(
            engine.session(),
            Segment {
                id: "fictional-boundary-line".into(),
                at_ms: engine.state.elapsed_ms,
                speaker: "Speaker".into(),
                speaker_id: None,
                text: "The fictional garden entrance closes before the meeting begins.".into(),
            },
        )
        .unwrap();
}
fn wait_finished(finished: &std::sync::atomic::AtomicBool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !finished.load(Ordering::Acquire) {
        assert!(Instant::now() < deadline, "held provider did not finish");
        std::thread::yield_now();
    }
}
const AUTH_RESPONSES: &[(&str, u16)] = &[
    ("anthropic", 401),
    ("anthropic", 403),
    ("openai", 401),
    ("openai", 403),
    ("gemini", 401),
    ("gemini", 403),
    ("gemini", 400),
];

#[test]
fn cancelled_auth_completion_cannot_reject_provider_after_lifecycle_boundary() {
    for &(provider, status) in AUTH_RESPONSES {
        for boundary in [
            "pause-resume",
            "off-regrant",
            "stop-drain",
            "new-session",
            "replacement-engine",
        ] {
            let (entered_tx, entered) = mpsc::channel();
            let (release, wait) = mpsc::channel();
            let rejected = Arc::new(AtomicUsize::new(0));
            let (mut engine, finished) = engine(
                provider,
                HeldResponse {
                    entered: entered_tx,
                    release: Some(wait),
                    status,
                },
                rejected.clone(),
            );
            speech(&mut engine);
            entered.recv_timeout(Duration::from_secs(5)).unwrap();
            // The completion fence outlives engine replacement and is set
            // only after the real provider adapter has processed the response.
            let previous_session = engine.session();
            match boundary {
                "pause-resume" => {
                    engine.set_live_cues_paused(true).unwrap();
                    engine.set_live_cues_paused(false).unwrap();
                }
                "off-regrant" => {
                    engine.revoke_processing();
                    approved(&mut engine);
                }
                "stop-drain" => engine.begin_live_stop(),
                "new-session" => {
                    engine.begin_live_stop();
                    assert!(engine.finish_live_stop(previous_session));
                    engine.start().unwrap();
                    approved(&mut engine);
                }
                "replacement-engine" => {
                    engine.begin_live_stop();
                    let mut replacement = Harness::new();
                    replacement.engine.end();
                    engine = crate::carry_over(&engine, replacement.engine);
                    engine.start().unwrap();
                    approved(&mut engine);
                }
                _ => unreachable!(),
            }
            release.send(()).unwrap();
            wait_finished(&finished);
            if boundary != "replacement-engine" {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !engine
                    .evaluation
                    .as_ref()
                    .unwrap()
                    .worker
                    .adapter_finished()
                {
                    assert!(Instant::now() < deadline);
                    std::thread::yield_now();
                }
            }
            engine.advance(10);
            assert_eq!(
                rejected.load(Ordering::SeqCst),
                0,
                "{provider} HTTP {status} after {boundary}"
            );
            assert!(engine.state.cue.is_none());
            assert_eq!(engine.state.status, Status::Running);
            assert_eq!(engine.is_live_stopping(), boundary == "stop-drain");
            assert_eq!(engine.has_processing_permission(), boundary != "stop-drain");
            assert_ne!(
                engine.evaluation_status(),
                Some(EvaluationStatus::Unavailable(EvaluationIssue::KeyRejected))
            );
            if matches!(boundary, "new-session" | "replacement-engine") {
                assert_ne!(engine.session(), previous_session);
                assert!(engine.state.transcript.is_empty());
            }
        }
    }
}

#[test]
fn current_auth_completion_still_rejects_provider_and_revokes_processing() {
    for &(provider, status) in AUTH_RESPONSES {
        let (entered_tx, entered) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let rejected = Arc::new(AtomicUsize::new(0));
        let (mut engine, finished) = engine(
            provider,
            HeldResponse {
                entered: entered_tx,
                release: Some(wait),
                status,
            },
            rejected.clone(),
        );
        speech(&mut engine);
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        release.send(()).unwrap();
        wait_finished(&finished);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !engine
            .evaluation
            .as_ref()
            .unwrap()
            .worker
            .adapter_finished()
        {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        engine.advance(10);
        assert_eq!(
            rejected.load(Ordering::SeqCst),
            1,
            "{provider} HTTP {status}"
        );
        assert!(!engine.has_processing_permission());
        assert!(engine.state.cue.is_none());
        assert_eq!(engine.state.status, Status::Running);
        assert_eq!(
            engine.evaluation_status(),
            Some(EvaluationStatus::Unavailable(EvaluationIssue::KeyRejected))
        );
    }
}
