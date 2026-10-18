# Both targets are built from services/matting as their context.
FROM python:3.12-slim AS cpu-deps
ENV REMBG_HOME=/models U2NET_HOME=/models PIP_NO_CACHE_DIR=1 OMP_NUM_THREADS=4
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements-cpu.txt .
RUN pip install -r requirements-cpu.txt
# Verify the installed CLI supports downloads, then bake every served model.
RUN rembg d --help && rembg d birefnet-general birefnet-general-lite birefnet-hrsod bria-rmbg
COPY app.py .

FROM cpu-deps AS cpu-tests
COPY requirements-test.txt .
RUN pip install -r requirements-test.txt
COPY tests tests
RUN python -m pytest tests -q && touch /tests-passed

FROM cpu-deps AS cpu
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA MATTE_TARGET=cpu
COPY --from=cpu-tests /tests-passed /tests-passed
RUN useradd -m app && chown -R app /app && chmod -R a-w /models
USER app
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]

# ORT 1.23.2 requires CUDA 12.8 and cuDNN 9. Ubuntu 24.04 provides Python 3.12.
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04 AS gpu-deps
ENV REMBG_HOME=/models U2NET_HOME=/models PIP_NO_CACHE_DIR=1 OMP_NUM_THREADS=4 PATH=/opt/venv/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv
WORKDIR /app
COPY requirements-gpu.txt .
RUN pip install -r requirements-gpu.txt
# Downloads do not require a GPU. The runtime verifies actual CUDA sessions.
COPY --from=cpu-deps /models /models
COPY app.py .

FROM gpu-deps AS gpu-tests
COPY requirements-test.txt .
RUN pip install -r requirements-test.txt
COPY tests tests
RUN python -m pytest tests -q && touch /tests-passed

FROM gpu-deps AS gpu
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA MATTE_TARGET=gpu
COPY --from=gpu-tests /tests-passed /tests-passed
RUN useradd -m app && chown -R app /app && chmod -R a-w /models
USER app
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
