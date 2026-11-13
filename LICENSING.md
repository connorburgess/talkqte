# Licensing TalkQTE

TalkQTE uses the [Sustainable Use License, Version 1.0](LICENSE), with separate commercial agreements for uses outside that license. Connor Burgess is the licensor and project steward. This guide explains the policy; it does not add restrictions to or replace the license text.

The source is public, but the commercial-use restrictions mean this is **source-available**, not OSI-approved open source. The same rules apply to everyone, including companies that make other meeting tools. There is no list of prohibited competitors.

## Everyday use and commercial products

| Use | Under the Sustainable Use License |
| --- | --- |
| Use the app personally | Permitted without a license fee |
| Use it for your company's internal meetings and work | Permitted without a license fee |
| Use your own installation while consulting or doing paid client work | Permitted as your internal business use; this does not include selling customers access to TalkQTE |
| Inspect or modify it for a permitted use | Permitted |
| Share a fork or copy free of charge for noncommercial purposes | Permitted with the license, notices, and a prominent notice of modifications |
| Sell or commercially redistribute TalkQTE or a modified version | Requires a separate commercial agreement |
| White-label TalkQTE for customers or embed its implementation in a commercial product | Requires a separate commercial agreement |
| Sell access to TalkQTE as a hosted service | Requires a separate commercial agreement |

An integration that connects a permitted TalkQTE installation to another application's API, without incorporating or distributing TalkQTE's implementation, does not by itself require a commercial agreement. The other application's terms still apply. Using your own notes, questions, or exported meeting content in paid work is not redistribution of TalkQTE's software.

The distinction is how the software is used or distributed, not whether its user earns money. Charging for a client-facing product powered by TalkQTE is different from using the app yourself during a paid meeting. If a case does not clearly fit the license, request terms before shipping it.

For a platform that uses TalkQTE as one part of something larger, including a hosted or managed service where no copy is handed over, a working test is whether TalkQTE is the thing being sold or a tool supporting something else being sold. A product, service, or module whose commercial value comes entirely or substantially from TalkQTE's functionality is outside "your own internal business purposes" and needs a commercial agreement, whether or not customers ever see TalkQTE. This follows [n8n's published explanation](https://github.com/n8n-io/n8n-docs/blob/53637d1c42bb95f19c4656637170e4158ba036e2/docs/n8n-community-license/license-faq.md) of the same license text for its own software; it is guidance, not a ruling on any particular case.

For commercial terms, open a [licensing inquiry](https://github.com/connorburgess/talkqte/issues/new?title=Commercial%20licensing%20inquiry) requesting a private contact. Keep confidential business details out of public issues. A commercial agreement is separate from buying the project; an inquiry does not grant permission.

## Name and logo

The software license does not grant trademark rights in the TalkQTE name or logo. A modified version shared with others needs its own name and icon unless you have permission to use TalkQTE's. See the [name and logo guide](TRADEMARKS.md) for what is fine without asking and what needs permission.

## Previously published Apache-2.0 material

TalkQTE was previously published under Apache-2.0. For reference, the main-branch snapshot at [`f61fa6c`](https://github.com/connorburgess/talkqte/tree/f61fa6ce1dd1e06d1375026e2708c978455cf77f) contains that license. Other commits and branches published under Apache-2.0 retain those grants too; this reference is not an exhaustive cutoff list.

This change does **not** revoke, narrow, or charge for rights already granted under Apache-2.0. Recipients may continue using, modifying, distributing, and commercializing that material under its original terms, including in forks. A later README or license change does not remove those permissions. The original license is preserved in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).

New material offered only under the Sustainable Use License is subject to that license. Preserve applicable Apache notices when reusing earlier material. Third-party dependencies, assets, and license documents retain their own terms; the project license does not relicense them. No historical commits or releases have been rewritten.

## Contributions

New contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) and the [contributor agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md). Contributors retain copyright and give the steward permission to license their contributions under other terms, including commercial terms. The agreement applies only when accepted; it is not retroactive and does not convert earlier DCO sign-offs into consent.

The original [DCO 1.1](LICENSES/DCO-1.1.txt) is preserved unchanged for historical reference. Current commit sign-offs record contribution origin; they do not certify DCO 1.1 or replace explicit contributor-agreement acceptance.

## Sources of the standard terms

- The Sustainable Use License body is reproduced unchanged from [n8n's license](https://github.com/n8n-io/n8n/blob/01bd57cddf11e8173b16adce1b22a8eb94598672/LICENSE.md#sustainable-use-license). n8n-specific enterprise and branch exclusions are not part of TalkQTE's policy.
- The short contributor agreement follows the [Indie Open Source Tiny CLA](https://github.com/indieopensource/tiny-cla/blob/v1.0.0/cla.md), also used by [n8n](https://github.com/n8n-io/n8n/blob/01bd57cddf11e8173b16adce1b22a8eb94598672/CONTRIBUTOR_LICENSE_AGREEMENT.md), with Connor Burgess named as steward.
