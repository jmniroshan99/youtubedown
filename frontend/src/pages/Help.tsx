import { Plus, ShieldCheck } from "lucide-react";

import { Heading } from "../components/feedback";
export default function Help() {
  const questions = [
    [
      "How do I create an account?",
      "Choose Create account and enter your full name, email, password and matching confirmation. Open the confirmation email if requested. You can also keep using the app as a guest.",
    ],
    [
      "Can I continue with Google or Facebook?",
      "Yes, when the site owner has enabled that provider. Choose its button on Sign in or Create account. If it is unavailable, use email or guest access. Signing into youtubedown does not unlock restricted videos on other websites.",
    ],
    [
      "Where is the video saved?",
      "The browser saves to its normal Downloads folder or asks you to choose a location, depending on your browser settings. Suggested filenames start with youtubedown - followed by the video title. The app cannot silently choose an arbitrary device folder or confirm a normal browser download has finished saving.",
    ],
    [
      "How do I download a video?",
      "Paste a complete video URL to check available formats. Select Video or Audio, choose your preferred available quality, and select Download. Pasting or changing a selection never starts a processing job. A smaller MP4 with audio is suggested when available; you can choose another quality. No login credentials are required. After your Download request, the browser download starts when ready; select Save file if the browser requires another click.",
    ],
    [
      "Will my guest downloads stay available?",
      "Current jobs belong to the session saved in this browser and expire automatically. Clearing browser data, ending the session, switching accounts or using another device can make them inaccessible. Signing in does not transfer guest downloads.",
    ],
    [
      "What are the guest limits?",
      "Defaults are one active job, five downloads per UTC day, 100 MB per file and two hours per video. Analysis and shared-network limits also apply. The site owner can adjust these limits. Guest videos must have a known duration. A video within the duration limit can still exceed the file-size limit; choose a smaller available format when needed.",
    ],
    [
      "Does every website work?",
      "No. The app checks supported public video pages, single embedded videos and direct media links. Some sources require their own login, restrict regions, block requests or do not expose downloadable formats. Protected streams, live content and playlists are not supported. Signing into youtubedown does not sign you into a video website.",
    ],
    [
      "Why is the service unavailable?",
      "The download backend may be offline, still starting, or not configured. Site owners should follow START_HERE.md to connect the API, worker, Redis and Supabase.",
    ],
    [
      "Why can quality and file size vary?",
      "Only formats exposed by the source are shown. Some sources separate audio and video. Estimated sizes are approximate; converted files can have a different size.",
    ],
    [
      "How long are my files kept?",
      "Prepared files are staged temporarily in private storage and removed automatically after the configured retention period. Current jobs also expire; no new permanent download history is created. Signed links are short-lived. Check the expiry beside your prepared file.",
    ],
    [
      "Can I request another source?",
      "First try the URL: generic extraction may already support it. Share a public example URL with your site administrator to request a new adapter.",
    ],
  ];
  return (
    <div className="standard-page narrow">
      <Heading
        eyebrow={"A LITTLE GUIDANCE"}
        title={"Good to know."}
        description={"Answers for a smoother download."}
      />
      <div className="faq-list">
        {questions.map(([question, answer], index) => (
          <details className="panel" key={question} open={index === 0}>
            <summary>
              {question}
              <Plus size={17} />
            </summary>
            <p>{answer}</p>
          </details>
        ))}
      </div>
      <div className="quality-note">
        <ShieldCheck size={25} />
        <p>
          {
            "Download only videos you own or have permission to save. This app does not bypass access controls."
          }
        </p>
      </div>
    </div>
  );
}
