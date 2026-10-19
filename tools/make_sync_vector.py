"""Génère tests/fixtures/sync_vector.json (partagé avec les tests JS de l'appli Android)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.sync import AAD_REQ, b64u, seal  # noqa: E402

key = bytes(range(32))
nonce = bytes(range(100, 112))
plaintext = {"type": "hello", "nom": "Café €"}
vector = {
    "key": b64u(key),
    "nonce": b64u(nonce),
    "aad": AAD_REQ.decode(),
    "plaintext": plaintext,
    "body": seal(key, plaintext, AAD_REQ, nonce).decode(),
}
out = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "sync_vector.json"
out.write_text(json.dumps(vector, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
print("écrit", out)
