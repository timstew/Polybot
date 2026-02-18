FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY pyproject.toml setup.cfg* ./
RUN pip install --no-cache-dir fastapi uvicorn requests pydantic aiosqlite \
    python-dotenv click rich websocket-client py-clob-client

# Copy application code
COPY polybot/ polybot/
COPY data/ data/

# Create data directory if it doesn't exist
RUN mkdir -p data

ENV POLYBOT_DB_PATH=data/polybot.db
ENV CLOUDFLARE_WORKER_URL=https://polybot-copy-listener.timstew.workers.dev
ENV PORT=8080

EXPOSE 8080

CMD ["uvicorn", "polybot.api:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "warning"]
