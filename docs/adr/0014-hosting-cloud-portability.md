# ADR-0014: Hostinger-first hosting, cloud-portable architecture

**Status:** Accepted · **Date:** 2026-09-24

## Context
Product decision (2026-09-24): the first environments and first production cell run on
**Hostinger VPS in India (Mumbai)**, which fits India-first go-to-market and DPDP Act data-residency
expectations. The architecture must stay portable to AWS, GCP, Azure or others without touching
business code. Hostinger provides virtual servers, not managed databases, queues, KMS or object
storage, so those services are self-hosted in containers.

## Decision
- **Runtime:** OCI containers everywhere.
  - Local development and single-node staging use Docker Compose.
  - Production cells run on **k3s** (lightweight Kubernetes) across several KVM VPS nodes, deployed
    with Helm charts.
  - No code depends on Kubernetes APIs; health endpoints and 12-factor config keep other runtimes viable.
- **Infrastructure as code:** Terraform (`infra/terraform/`) for server provisioning, DNS and
  firewall, using Hostinger's Terraform provider for the resources it covers. Host configuration
  and hardening use Ansible (`infra/ansible/`). Any resource that cannot be automated is recorded
  as a documented manual step until it can be. Terraform modules are split into provider-specific
  `providers/hostinger` and provider-neutral `cell` layers, so another cloud adds a provider module
  only.
- **Self-hosted stateful services per cell:**
  - PostgreSQL via the CloudNativePG operator, with synchronous replica, PITR and backups to object storage.
  - Redis.
  - Keycloak.
  - S3-compatible object storage: MinIO, with object lock for audit anchors.
  - OpenBao (the open-source Vault fork) for secrets and the transit/KMS function.
  - The OTel/Prometheus/Grafana/Loki/Tempo stack.
- **Provider abstractions:** business and domain code never imports a cloud SDK. Everything goes
  through platform ports, with adapters in `backend/adapters`:
  | Port | First adapter | Later |
  |---|---|---|
  | `StorageProvider` | S3-compatible API (MinIO) | AWS S3, GCS, Azure Blob, Cloudflare R2 |
  | `EmailProvider` | SMTP (any relay) | SES, SendGrid, Postmark |
  | `SecretsProvider` / `KeyManagement` | OpenBao KV + transit | AWS KMS/Secrets Manager, GCP KMS, Azure Key Vault |
  | `AiProvider` | OpenAI | Anthropic, Gemini, Azure OpenAI, self-hosted (ADR-0017) |
  | `PaymentProvider` | Razorpay, Stripe, Manual | Adyen, others |
  | `MessageBroker` (Phase 12) | Kafka-compatible (Kafka/Redpanda, self-hosted) | managed Kafka |

  An ArchUnit rule forbids cloud SDK packages (`software.amazon..`, `com.google.cloud..`,
  `com.azure..`, `io.minio..`) outside `backend/adapters`.
- **No multi-cloud deployment** is built in the MVP. Portability is a property of the code and the
  Terraform layering, not a running deployment.
- **Region registry:** the region `in-mum` (provider `hostinger`, jurisdiction `IN`) is data in the
  control plane (ADR-0001). A second provider or region is Terraform plus a control-plane record.

## Consequences
+ Low cost and India data residency from the start; no lock-in to managed services.
− We operate Postgres HA, backups, Keycloak, MinIO and OpenBao ourselves, so runbooks and restore
  drills are required before the first paying tenant.
− Off-site backups need a second location within India. The target (a second Hostinger data
  center or an India-region S3-compatible service) is decided before production launch; see
  roadmap open questions.
− No managed WAF/DDoS by default. An edge/CDN provider is chosen before production launch.

## Alternatives
AWS first (the earlier default, superseded by the product decision; remains the primary
migration target). Managed PaaS (rejected: residency and cost uncertainty).
