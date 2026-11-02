"""Safe device filenames and opaque temporary-object ownership markers."""

import re
import unicodedata
from uuid import UUID

TEMPORARY_OBJECT = re.compile(r"^ephemeral/([0-9a-f-]{36})__([0-9a-f-]{36})__([0-9]{10,12})\.([a-z0-9]{1,10})$")


def temporary_path_expiry(path, user_id=None, job_id=None):
    match = TEMPORARY_OBJECT.fullmatch(path or "")
    if not match:
        return None
    uid, jid, expiry, _ = match.groups()
    try:
        UUID(uid), UUID(jid)
    except ValueError:
        return None
    if (user_id is not None and uid != user_id) or (job_id is not None and jid != job_id):
        return None
    return int(expiry)


def download_filename(title, extension):
    ext = str(extension).lower().lstrip(".")
    if not re.fullmatch(r"[a-z0-9]{1,10}", ext):
        raise ValueError("Invalid output extension")
    text = unicodedata.normalize("NFC", str(title or "Untitled video"))
    text = "".join(
        " " if unicodedata.category(char).startswith("C") and char not in {"\u200c", "\u200d"} else char
        for char in text
    )
    text = re.sub(r'[<>:"/\\|?*]', " ", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    text = re.sub(r"\.{2,}", ".", text)
    text = text.encode("utf-8")[:170].decode("utf-8", errors="ignore").rstrip(" .") or "Untitled video"
    # The fixed prefix also prevents Windows reserved-device basenames such as CON.
    return f"youtubedown - {text}.{ext}"
