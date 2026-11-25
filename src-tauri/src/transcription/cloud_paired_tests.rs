// Synthetic state-machine -> production timing writer -> public JS launcher.
// No native app, capture, provider socket, grant endpoint or credentials.
use std::io::{BufRead, Write};
use std::process::Command;

#[test]
fn reconnect_timing_pairs_with_public_launcher() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut command = Command::new("node");
    command
        .arg(root.join("scripts/fixtures/paired-reconnect-launcher.mjs"))
        .arg(std::env::current_exe().unwrap())
        .env_clear();
    for key in ["PATH", "TMPDIR", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
}

#[test]
#[ignore = "isolated synthetic timing-log child, invoked by paired launcher test"]
fn reconnect_timing_child() {
    use crate::timing_log::{record, Event};
    let path = std::env::var(crate::timing_log::ENV).unwrap();
    let run = std::env::var("TALKQTE_DEV_LAB_RUN_ID").unwrap();
    record(Event::Evaluator {
        approval: "review",
        session: 7,
        state: "on",
        backend: "lab-api".into(),
        model: "claude-opus-5-5".into(),
        effort: Some("low".into()),
        elapsed_ms: 0,
    });
    record(Event::DevStop {
        run_id: run.clone(),
        step: "armed",
    });
    let first = Script::default();
    let pending = Script::default();
    let last = Script::default();
    let extras: Vec<Script> = (2..super::MAX_RECONNECTS)
        .map(|_| Script::default())
        .collect();
    let (feed, _) = feed(&first, Arc::new(Mutex::new(true)));
    let lost = Arc::new(Mutex::new(Vec::new()));
    let notify = lost.clone();
    let mut streams = Vec::with_capacity(super::MAX_RECONNECTS as usize);
    streams.push(pending.clone());
    streams.push(last.clone());
    streams.extend(extras.iter().cloned());
    let opens = Arc::new(Mutex::new(0usize));
    let count = opens.clone();
    let mut feed = Some(
        feed.reconnect_with(Box::new(move || {
            // Read the exact current token file at each replacement boundary,
            // using the real metadata/content guard; never open a connection.
            let file = std::env::var("TALKQTE_DEV_STT_TOKEN_FILE").unwrap();
            assert_eq!(
                read_token(std::path::Path::new(&file)).unwrap(),
                "fictional.offline-reconnect-token.0123456789"
            );
            let mut n = count.lock().unwrap();
            let stream = streams.get(*n).ok_or(SttFailure::Settings)?.clone();
            *n += 1;
            Ok(Box::new(stream) as Box<dyn StreamingTranscriber>)
        }))
        .on_reconnect(move |ms| notify.lock().unwrap().push(ms)),
    );
    let query = super::super::super::deepgram::ListenRequest::lab()
        .query()
        .to_owned();
    let mut stage = 0usize;
    for line in std::io::stdin().lock().lines() {
        let command = line.unwrap();
        let mut result = Ok(());
        match command.as_str() {
            "start" => result = feed.as_mut().unwrap().push(0, 100, &[0.0; 1600]),
            "first-connected" => {
                first.events.lock().unwrap().push(SttEvent::Connected {
                    query: query.clone(),
                });
                result = feed.as_mut().unwrap().poll();
            }
            "first-failed" => {
                first
                    .events
                    .lock()
                    .unwrap()
                    .push(SttEvent::Failed(SttFailure::Network));
                result = feed.as_mut().unwrap().poll();
            }
            "pending-failed" => {
                feed.as_mut().unwrap().push(100, 200, &[0.0; 1600]).unwrap();
                pending
                    .events
                    .lock()
                    .unwrap()
                    .push(SttEvent::Failed(SttFailure::Network));
                result = feed.as_mut().unwrap().poll();
            }
            "last-connected" => {
                last.events.lock().unwrap().push(SttEvent::Connected {
                    query: query.clone(),
                });
                result = feed.as_mut().unwrap().poll();
            }
            "exhaust-to-cap" => {
                last.events
                    .lock()
                    .unwrap()
                    .push(SttEvent::Failed(SttFailure::Network));
                result = feed.as_mut().unwrap().poll();
                if result.is_ok() {
                    let last_idx = extras.len().saturating_sub(1);
                    for (idx, script) in extras.iter().enumerate() {
                        script.events.lock().unwrap().push(SttEvent::Connected {
                            query: query.clone(),
                        });
                        result = feed.as_mut().unwrap().poll();
                        if result.is_err() || idx == last_idx {
                            break;
                        }
                        script
                            .events
                            .lock()
                            .unwrap()
                            .push(SttEvent::Failed(SttFailure::Network));
                        result = feed.as_mut().unwrap().poll();
                        if result.is_err() {
                            break;
                        }
                    }
                }
            }
            "last-failed" => {
                extras
                    .last()
                    .unwrap_or(&last)
                    .events
                    .lock()
                    .unwrap()
                    .push(SttEvent::Failed(SttFailure::Network));
                result = feed.as_mut().unwrap().poll();
            }
            "stop-pending" => {
                record(Event::DevStop {
                    run_id: run.clone(),
                    step: "latched",
                });
                record(Event::DevStop {
                    run_id: run.clone(),
                    step: "stopping",
                });
                pending.events.lock().unwrap().push(SttEvent::Connected {
                    query: query.clone(),
                });
                feed.take().unwrap().finish(Duration::from_millis(1));
                record(Event::DevStop {
                    run_id: run.clone(),
                    step: "released",
                });
            }
            "end" => {
                if let Some(feed) = feed.take() {
                    feed.end();
                }
            }
            "exit" => break,
            _ => panic!("unknown synthetic command"),
        }
        // A production writer barrier, not a sleep-based assumption that
        // CloudFeed rows have reached the JS reader.
        stage += 1;
        record(Event::UserNameSet {
            session: 7,
            set: false,
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            if text
                .lines()
                .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
                .filter(|v| v["event"] == "user_name_set")
                .count()
                == stage
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timing writer barrier"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        println!(
            "PAIR {}",
            serde_json::json!({"command":command,"result":result.err().map(SttFailure::code),"callbacks":*lost.lock().unwrap(),"opens":*opens.lock().unwrap(),"firstAborted":*first.aborted.lock().unwrap(),"pendingAborted":*pending.aborted.lock().unwrap()})
        );
        std::io::stdout().flush().unwrap();
    }
}
