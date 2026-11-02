FROM python:3.12-slim-bookworm
WORKDIR /proxy
COPY backend/app/security.py app/security.py
COPY egress/proxy.py proxy.py
USER 65534:65534
CMD ["python", "proxy.py"]
