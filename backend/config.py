# What it does: Load env vars via python-dotenv, expose as constants, and validate them
# Module: Setup

import os
from dotenv import load_dotenv

load_dotenv()

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY")
MAX_FILES = int(os.getenv("MAX_FILES", 60))
CACHE_DIR = os.getenv("CACHE_DIR", "./cache")
MAX_ENRICH_NODES = int(os.getenv("MAX_ENRICH_NODES", 60))
GROQ_SUMMARY_MODEL = os.getenv("GROQ_SUMMARY_MODEL", "openai/gpt-oss-20b")
GROQ_CHAT_MODEL = os.getenv("GROQ_CHAT_MODEL", "openai/gpt-oss-120b")
MISTRAL_MODEL = os.getenv("MISTRAL_MODEL", "mistral-small-latest")

# Browser origins allowed to call the API (CORS), comma-separated
DEFAULT_ALLOWED_ORIGINS = "https://code-graph-ashy.vercel.app,http://localhost:5173"
ALLOWED_ORIGINS = [
    o.strip().rstrip("/") for o in os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",") if o.strip()
]
# /analyze: analyses one IP may start per hour
ANALYZE_LIMIT_PER_HOUR = int(os.getenv("ANALYZE_LIMIT_PER_HOUR", 10))
# ADMIN_KEY (for /cache) is read per request, so it is not cached here

def validate_config():
    errors = []
    if not GITHUB_TOKEN:
        errors.append("GITHUB_TOKEN is not set")
    if not GROQ_API_KEY:
        errors.append("GROQ_API_KEY is not set")
    if not MISTRAL_API_KEY:
        errors.append("MISTRAL_API_KEY is missing (fallback won't work)")
    if errors:
        for e in errors:
            print(f"[config] FATAL: {e}")
        raise SystemExit(1)
