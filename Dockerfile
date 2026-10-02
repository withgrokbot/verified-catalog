# MCP server for the verified catalog (stdio, Python standard library only).
# docker build -t verified-catalog-mcp . && docker run -i --rm verified-catalog-mcp
FROM python:3.12-slim
WORKDIR /app
COPY catalog.json /app/catalog.json
COPY mcp/server.py /app/mcp/server.py
RUN useradd --create-home --uid 10001 mcp
USER mcp
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "/app/mcp/server.py"]
