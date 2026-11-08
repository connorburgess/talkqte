# Operating estimates

Status: first estimate, 9 November 2026. It separates what was measured from what is estimated or still unknown. It is planning input for the [product readiness plan](product-readiness.md#production-and-scaling-approach), not a budget or a commitment. Nothing here is a current call to download.

## Measured

| Item                     | Size                            | How it was measured                                                                                                                       |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| App bundle               | 15.3 MiB on disk, 4.7 MB zipped | `npm run tauri -- build --bundles app --features local-whisper`, ad-hoc signed, Apple silicon (arm64) only, compressed with `ditto -c -k` |
| Speech model (`tiny.en`) | 77.7 MB (77,704,715 bytes)      | The pinned file in [model delivery](model-delivery.md); gzip shrinks it only to 70.5 MB, so compressing it for delivery saves little      |

Derived from these: a first download is about 82 MB (4.7 MB app plus 77.7 MB model), and about 94 MB on disk once installed. The model is optional and only needed for live sessions.

A disk image, a universal build that also runs on Intel Macs, and a notarized build were not measured. A universal build carries a second copy of the executable, so expect a larger app download than the arm64 figure.

## Where the bytes come from

- **App:** planned on the project's GitHub Releases. GitHub states: "Each file included in a release must be under 2 GiB. There is no limit on the total size of a release, nor bandwidth usage" ([About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)). Its general terms still allow it to act on excessive use, so this is not a guarantee.
- **Model:** today downloaded from the whisper.cpp repository on Hugging Face at a pinned revision. Hugging Face applies rate limits over 5-minute windows, with separate buckets for API calls and file downloads ("resolvers"), and file downloads have the highest limits ([Hub rate limits](https://huggingface.co/docs/hub/rate-limits)). As of that page's September 2025 table, anonymous file downloads are limited to 3,000 per 5 minutes per IP address, and the anonymous and free limits are marked as subject to change. A rate-limited request gets a 429 response with a `RateLimit` header giving the time to reset. Because the limit is per IP address, the risk is many people behind one office network, not the total number of installs. The [model delivery plan](model-delivery.md) plans a GitHub Releases copy as the primary source with Hugging Face as fallback; that copy is not published yet, so Hugging Face is the only source today, and if the pinned upstream revision were removed, every model download would fail.

## Rough scale

Bandwidth only, assuming every user takes the model and each app update is a full download of the arm64 bundle:

| Installs | First installs | One app update for everyone |
| -------- | -------------- | --------------------------- |
| 100      | about 8 GB     | about 0.5 GB                |
| 1,000    | about 82 GB    | about 4.7 GB                |
| 10,000   | about 825 GB   | about 47 GB                 |

A model change adds about 78 MB per user who updates it. At these sizes, delivery through GitHub Releases and Hugging Face is not expected to need hosted infrastructure of the project's own, as long as their current terms hold.

## Operating costs

- **Inference in the app:** none paid by the project. Transcription runs on the user's Mac, and cue rules run in the app. A future "bring your own key" option would be paid by the user to their chosen provider ([model delivery](model-delivery.md#bring-your-own-key-later)).
- **Inference in development:** the [Claude cue lab](claude-cue-lab.md) sends fictional cases to Anthropic's hosted model and uses the owner's existing subscription allowance, with paid extra usage confirmed off before each run. It is not part of the app.
- **Hosting:** none for app delivery today; see above. The public concept site is a separate repository with its own hosting and domain, outside this estimate.
- **Signing and notarization:** needs a paid annual Apple Developer Program membership, an owner decision that is not yet made. Signed updates also need an update-signing key whose custody (where it is kept, who can use it, and how it is recovered) must be decided before the first signed release.
- **Telemetry:** none, by design ([privacy](../PRIVACY.md)). Usage and failure rates must therefore come from opt-in reports or support conversations, not automatic collection.

## Support effort

Not estimated: there are no users, and no pilot has run. The likely first topics, from the features most dependent on each person's setup, are microphone permission, the model download, and companion placement on different displays and meeting apps. A pilot should record, per participant: setup time, the issues raised and their topics, and time spent resolving them. Those numbers, not guesses, should set support capacity.

## When more infrastructure would be justified

Record the evidence first, as the [product readiness plan](product-readiness.md#production-and-scaling-approach) requires. Signals that would justify a change:

- **Model downloads failing or rate limited** for a noticeable share of users: publish the GitHub Releases copy (already planned), then consider a CDN.
- **Update traffic or failed updates** becoming a support topic: consider delta updates or a dedicated update host.
- **Support volume** beyond what the owner can answer within a stated response time: a help page and a structured issue template first, then a support channel.
- **Hosted features** such as shared sessions or hosted inference: each needs its own data boundary, cost model, and decision; none is planned.

## Follow-up

- The downloader does not tell error responses apart: a 429, a 404, and a server error are all reported as "could not be reached" and retried up to three times. It should read the `RateLimit` reset time on a 429 and wait or tell the user, and treat a 403 or 404 as permanent.
- Measure the disk image, universal, and notarized builds when signing is decided.
