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
