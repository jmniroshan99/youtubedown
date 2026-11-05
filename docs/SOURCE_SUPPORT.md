# Website compatibility

Updated 5 November 2026: [current evidence and verification](WEBSITE_SUPPORT_VERIFICATION.md) and [English setup](WEBSITE_SUPPORT_SETUP.md) supersede the older verification limits below. Pornhub/xHamster dedicated URL paths have offline fixtures; live compatibility is not claimed.

youtubedown cannot guarantee downloads from every website. It checks the pasted public URL with the installed yt-dlp extractors, including generic media detection. The Video sources page is a registry of configured examples and administrator rules, not an exhaustive whitelist.

## Supported paths

| Link type | Behavior |
|---|---|
| Public video page recognized by an extractor | Show only formats the source actually reports. |
| Public page with one ordinary HTML5 embedded video | Detect its media URL and probe missing codec/duration metadata through guarded egress. |
| Direct MP4/WebM or supported native media | Offer actual source formats and their real output extensions. |
| Supported non-live HLS/DASH | Existing bounded fragment download and stream-copy processing remain available. |
| MOV/MKV/FLV/AVI/3GP/M4V/TS reported by the source | Offer compatible native variants where metadata supports them; never claim an MP4 conversion that did not happen. |

Some native containers need a compatible player on the user's device. MP4 remains the suggested video format when available. The UI still requires Video/Audio and an explicit Download click.

## Clear failure messages

The app now separates unsupported links, source login requirements, age/access restrictions, source blocking, request limits, unavailable videos, region restrictions, network errors and administrator-disabled sources. Unknown failures stay generic rather than inventing a cause or exposing diagnostic URLs/tokens.

For a normal article or landing page, try the video's own page or a direct public media URL. For multiple videos or playlists, use one video's URL. If the source blocks the server, changes its player or exposes no usable formats, the app may not be able to retrieve it. Retrying cannot guarantee access.

Signing in to youtubedown with email, Google or Facebook does not authenticate to an unrelated video website. This version does not import browser cookies, bypass protected streams or use alternate extractors to evade an identified access restriction. Live streams and playlists remain unsupported.

## Security and privacy retained

Only validated public HTTP(S) sources go through the existing guarded proxy. Private/internal addresses, unsafe redirects/protocols, disabled-source rules, guest quotas, byte/duration limits and owner checks remain enforced. Provider metadata does not grant administrator access. No new permanent download history is created.

Existing known extractors and generic fallback were already present. This update fixes embedded-media probing, adds truthful native-container choices and provides safe failure categories. It does not establish universal compatibility.

## Verification limits

Actual local synthetic HTML5-embedded MP4 and native MKV analysis/download were tested for account and guest policies, alongside existing MP4/MP3/HLS/DASH fixtures. Native container options and failure classification have automated regressions. The user's screenshot website was not accessed or tested, and no live external-source success is claimed.

Source support can change independently of this app. Review the installed version and current official [yt-dlp supported-site list](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) when maintaining the backend; generic extraction can sometimes handle sites absent from that list. Keep dependency changes pinned and retest the existing security/media checks.

