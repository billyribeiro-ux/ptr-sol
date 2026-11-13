FROM canyan/janus-gateway:latest AS janus-tools
RUN mkdir -p /opt/januslib && ldd /usr/local/bin/janus-pp-rec | awk '/=> \// {print $3}' | while read lib; do case "$lib" in */libc.so.*|*/libm.so.*|*/libdl.so.*|*/libpthread.so.*|*/librt.so.*) ;; *) cp "$lib" /opt/januslib/ ;; esac; done
FROM python:3.13-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=janus-tools /usr/local/bin/janus-pp-rec /opt/janus/janus-pp-rec
COPY --from=janus-tools /opt/januslib /opt/januslib
RUN printf '#!/bin/sh\nLD_LIBRARY_PATH=/opt/januslib exec /opt/janus/janus-pp-rec "$@"\n' > /usr/local/bin/janus-pp-rec && chmod +x /usr/local/bin/janus-pp-rec
COPY docker/media-processor.py /opt/ptr/media-processor.py
ENV RECORDINGS_DIR=/app/data/recordings
EXPOSE 8090
CMD ["python3", "/opt/ptr/media-processor.py"]
