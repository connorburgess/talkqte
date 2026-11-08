//! Developer check: replay a fictional synthetic clip into a live session in
//! real time through the transcription worker and local Whisper, and report
//! when the cue appears, is answered, or the session ends.
//!
//!   cargo run --features local-whisper --example replay_clip -- \
//!     --model /path/ggml-tiny.en.bin --clip /path/clip.wav [--chunk-ms 4000] [--end-at-ms N]
//!
//! Prints only cue questions, source IDs, counts, and timings, never
//! transcript text. Reads the clip and model; writes nothing.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use talkqte_lib::{
    engine::Engine,
    transcription::{whisper::LocalWhisper, AudioChunk, Worker, SAMPLE_RATE},
};

struct Args {
    model: PathBuf,
    clip: PathBuf,
    chunk_ms: u64,
    end_at_ms: Option<u64>,
    report_every_ms: u64,
}

fn args() -> Result<Args, String> {
    let mut model = None;
    let mut clip = None;
    let mut chunk_ms = 4_000;
    let mut end_at_ms = None;
    let mut report_every_ms = 60_000;
    let mut list = std::env::args().skip(1);
    while let Some(flag) = list.next() {
        let value = list.next().ok_or(format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--model" => model = Some(PathBuf::from(value)),
            "--clip" => clip = Some(PathBuf::from(value)),
            "--chunk-ms" => chunk_ms = value.parse().map_err(|_| "--chunk-ms must be a number")?,
            "--report-every-ms" => {
                report_every_ms = value
                    .parse()
                    .map_err(|_| "--report-every-ms must be a number")?
            }
            "--end-at-ms" => {
                end_at_ms = Some(value.parse().map_err(|_| "--end-at-ms must be a number")?)
            }
            other => return Err(format!("unknown flag {other}")),
        }
    }
    if !(1_000..=30_000).contains(&chunk_ms) {
        return Err("--chunk-ms must be between 1000 and 30000".into());
    }
    Ok(Args {
        model: model.ok_or("--model is required")?,
        clip: clip.ok_or("--clip is required")?,
        chunk_ms,
        end_at_ms,
        report_every_ms: report_every_ms.max(1_000),
    })
}

/// Reads a 16-bit PCM, 16 kHz mono WAV file.
fn read_wav(path: &PathBuf) -> Result<Vec<f32>, String> {
    // About 17 minutes of 16 kHz 16-bit audio; refuse larger files.
    const MAX_BYTES: u64 = 32 * 1024 * 1024;
    let size = std::fs::metadata(path)
        .map_err(|_| "the clip could not be read")?
        .len();
    if size > MAX_BYTES {
        return Err("the clip is larger than 32 MiB".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "the clip could not be read")?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("the clip is not a WAV file".into());
    }
    let mut at = 12;
    let mut format_ok = false;
    while at + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
        match &bytes[at..at + 4] {
            b"fmt " if body.len() >= 16 => {
                let tag = u16::from_le_bytes([body[0], body[1]]);
                let channels = u16::from_le_bytes([body[2], body[3]]);
                let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                let bits = u16::from_le_bytes([body[14], body[15]]);
                format_ok = (tag, channels, rate, bits) == (1, 1, SAMPLE_RATE as u32, 16);
            }
            b"data" if format_ok => {
                return Ok(body
                    .chunks_exact(2)
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32_768.0)
                    .collect())
            }
            b"data" => break,
            _ => {}
        }
        at += 8 + size + (size & 1);
    }
    Err("the clip must be 16 kHz mono 16-bit PCM".into())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("replay_clip: {message}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let args = args()?;
    let samples = read_wav(&args.clip)?;
    let clip_ms = samples.len() as u64 * 1_000 / SAMPLE_RATE as u64;
    if args.end_at_ms.is_some_and(|end| end >= clip_ms) {
        return Err("--end-at-ms must fall within the clip".into());
    }
    let recognizer = LocalWhisper::load(&args.model, 4)?;
    let engine = Arc::new(Mutex::new(Engine::live()));
    let session = {
        let mut engine = engine.lock().unwrap();
        engine.start()?;
        engine.session()
    };
    let sink_engine = engine.clone();
    let begun = Instant::now();
    // Delay from when a line started being spoken to when the engine has it.
    let delays = Arc::new(Mutex::new(Vec::<u64>::new()));
    let sink_delays = delays.clone();
    let worker = Worker::start(session, 8, recognizer, move |session, segment| {
        let spoken_at = segment.at_ms;
        let result = sink_engine.lock().unwrap().ingest(session, segment);
        if result.is_ok() {
            let delay = (begun.elapsed().as_millis() as u64).saturating_sub(spoken_at);
            sink_delays.lock().unwrap().push(delay);
        }
        result
    });
    let mut next_report = args.report_every_ms;
    println!(
        "pid={} (sample memory and CPU from outside if `ps` is sandboxed)",
        std::process::id()
    );
    let chunk_samples = (args.chunk_ms as usize * SAMPLE_RATE) / 1_000;
    let mut next_chunk = 0usize;
    let mut shown: Option<String> = None;
    let mut last_remaining_ms = 0;
    let mut max_backlog = 0;
    println!("clip_ms={clip_ms} chunk_ms={}", args.chunk_ms);
    let ended = loop {
        let now_ms = begun.elapsed().as_millis() as u64;
        // Hand over each chunk once its audio has "arrived" in real time.
        let chunk_start = next_chunk * chunk_samples;
        let chunk_end = (chunk_start + chunk_samples).min(samples.len());
        if chunk_start < samples.len() && now_ms >= chunk_end as u64 * 1_000 / SAMPLE_RATE as u64 {
            let chunk = AudioChunk {
                start_ms: chunk_start as u64 * 1_000 / SAMPLE_RATE as u64,
                samples: samples[chunk_start..chunk_end].to_vec(),
            };
            if worker.submit(chunk).is_err() {
                println!("t={now_ms}ms chunk {next_chunk} dropped");
            }
            next_chunk += 1;
        }
        max_backlog = max_backlog.max(worker.backlog());
        if now_ms >= next_report {
            println!(
                "t={}s backlog={} lines={} {}",
                now_ms / 1_000,
                worker.backlog(),
                delays.lock().unwrap().len(),
                usage().map_or("usage unavailable".into(), |(rss, cpu)| format!(
                    "rss_mb={rss:.0} cpu_s={cpu:.1}"
                ))
            );
            next_report += args.report_every_ms;
        }
        let mut engine = engine.lock().unwrap();
        // Keep the engine clock on real time without dropping fractions.
        let target = begun.elapsed().as_millis() as u64;
        let elapsed = engine.state.elapsed_ms;
        engine.advance(target.saturating_sub(elapsed));
        let end_now = args.end_at_ms.is_some_and(|end| now_ms >= end);
        let cue = engine.state.cue.as_ref().map(|cue| cue.id.clone());
        if cue != shown || end_now {
            if let Some(cue) = engine.state.cue.as_ref().filter(|_| cue != shown) {
                println!(
                    "t={now_ms}ms cue shown kind={} source={} question={:?}",
                    cue.kind, cue.source_id, cue.question
                );
            } else if shown.is_some() && cue.is_none() {
                // An expiry happens within one tick, so little time is left.
                let reason = if last_remaining_ms <= 250 {
                    "expired"
                } else {
                    "withdrawn"
                };
                println!("t={now_ms}ms cue {reason} ({last_remaining_ms}ms of display time left)");
            }
            shown = cue;
        }
        last_remaining_ms = engine.state.cue.as_ref().map_or(0, |cue| cue.remaining_ms);
        if end_now {
            let backlog = worker.backlog();
            let had_cue = engine.state.cue.is_some();
            engine.end();
            println!(
                "t={now_ms}ms session ended lines={} backlog={backlog}{}",
                engine.state.transcript.len(),
                if had_cue { " (cue cleared by End)" } else { "" }
            );
            break Some((
                backlog,
                engine.state.revision,
                engine.state.transcript.len(),
            ));
        }
        drop(engine);
        let done_feeding = next_chunk * chunk_samples >= samples.len();
        if (done_feeding && worker.backlog() == 0 && now_ms > clip_ms + 1_000)
            || now_ms > clip_ms + 60_000
        {
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    if let Some((backlog, revision, lines)) = ended {
        if backlog == 0 {
            return Err("End came between chunks, so it interrupted nothing; choose an --end-at-ms during a chunk's transcription".into());
        }
        // Let work already in progress try to deliver into the ended session,
        // so the engine's own refusal of late lines is exercised.
        let wait = Instant::now();
        while worker.backlog() > 0 && wait.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let stats = worker.stop(); // Outside the engine lock; delivery takes it.
        let engine = engine.lock().unwrap();
        let unchanged = engine.state.revision == revision && engine.state.transcript.len() == lines;
        println!("worker {stats:?}");
        println!(
            "after end: chunks in progress or queued={backlog}, late lines refused by the engine={}, changes after end={}",
            stats.rejected, !unchanged
        );
        if !unchanged {
            return Err("the session changed after End".into());
        }
    } else {
        let stats = worker.stop();
        let engine = engine.lock().unwrap();
        println!("worker {stats:?} max_backlog={max_backlog}");
        let mut delays = delays.lock().unwrap().clone();
        delays.sort_unstable();
        if !delays.is_empty() {
            let at = |q: f64| delays[((delays.len() - 1) as f64 * q).round() as usize];
            println!(
                "line delay ms: p50={} p95={} max={} (n={}, includes waiting for the chunk to fill)",
                at(0.5),
                at(0.95),
                at(1.0),
                delays.len()
            );
        }
        println!(
            "resources after {:.0}s: {}",
            begun.elapsed().as_secs_f64(),
            usage().map_or("unavailable".into(), |(rss, cpu)| format!(
                "rss_mb={rss:.0} cpu_s={cpu:.1}"
            ))
        );
        println!(
            "lines={} final_cue={:?}",
            engine.state.transcript.len(),
            engine.state.cue.as_ref().map(|cue| &cue.question)
        );
    }
    Ok(())
}

/// Resident memory (MB) and total CPU seconds of this process, from `ps`.
/// None when `ps` cannot run, for example under a sandbox.
fn usage() -> Option<(f64, f64)> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=,time=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    let text = String::from_utf8(out.stdout).ok()?;
    let mut parts = text.split_whitespace();
    let rss_mb = parts.next()?.parse::<f64>().ok()? / 1_024.0;
    // TIME is [[hh:]mm:]ss.ss
    let cpu_s = parts.next()?.split(':').try_fold(0.0, |total, part| {
        part.parse::<f64>().ok().map(|n| total * 60.0 + n)
    })?;
    Some((rss_mb, cpu_s))
}
