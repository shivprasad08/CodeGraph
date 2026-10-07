FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# git is needed to clone repositories for analysis; build-essential for tree-sitter fallbacks
RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir --upgrade setuptools \
    && pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# ADJUST "main:app" to your FastAPI entrypoint (e.g. app.main:app)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]