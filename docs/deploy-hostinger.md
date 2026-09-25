# Deploying on a Hostinger VPS

This works on any Linux server with Docker. Nothing in the code is specific to Hostinger.

## 1. Server

- **Plan:** a Hostinger **KVM 2 (8 GB RAM)** is enough for staging. Use **KVM 4 (16 GB)** once real customers arrive. The stack runs about 13 containers.
- **OS:** Ubuntu 24.04 LTS.
- **Region:** India (Mumbai) for Indian customers.
- Point a domain at the server's IP, for example `erp.example.com` (A record).

## 2. Prepare the server

```bash
# as root
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
adduser erp && usermod -aG docker erp
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
```

## 3. Get the code and configure

```bash
su - erp
git clone https://github.com/mynameiscod/erp-global.git && cd erp-global
node infra/scripts/gen-env.mjs --prod   # needs Node 22; or run it on your laptop and copy the file
chmod 600 .env.production
```

Edit `.env.production`:

| Setting                                                                                 | Set it to                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`                                                                               | `https://erp.example.com`                                                                                                                      |
| `PLATFORM_ADMIN_EMAIL`                                                                  | your email (Super Admin, sign in with company `platform`)                                                                                      |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`          | your Hostinger mailbox, e.g. `smtp.hostinger.com`, `465`, `true`                                                                               |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (optional)                                   | Google Cloud Console → Credentials → OAuth client (Web). Redirect URL `https://erp.example.com/api/v1/identity/sso/google/callback`            |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (optional)                             | Entra ID → App registrations (multi-tenant + personal accounts). Redirect URL `https://erp.example.com/api/v1/identity/sso/microsoft/callback` |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_OTP_TEMPLATE` (optional) | Meta Business Manager → WhatsApp → API setup, with an approved **Authentication** template                                                     |

Keep a secure copy of this file. Its keys decrypt 2FA secrets and sign logins.

## 4. Start

```bash
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps        # all services "healthy"
```

The web container listens on `127.0.0.1:8080` only, so HTTPS goes in front of it.

## 5. HTTPS (Nginx + Let's Encrypt on the host)

```bash
# as root
apt install -y nginx certbot python3-certbot-nginx
cat > /etc/nginx/sites-available/erp <<'EOF'
server {
  server_name erp.example.com;
  client_max_body_size 26m;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
EOF
ln -s /etc/nginx/sites-available/erp /etc/nginx/sites-enabled/erp
nginx -t && systemctl reload nginx
certbot --nginx -d erp.example.com --redirect
```

The client IP passes through host Nginx, then the web container, then the gateway, then identity. The compose file is set for those hops.

## 6. Backups

```bash
# nightly at 02:30, keeps 14 days locally; copy the folder off the server (S3, Backblaze, another VPS)
crontab -e
30 2 * * * cd /home/erp/erp-global && ./infra/scripts/backup-mongo.sh >> /home/erp/backup.log 2>&1
```

Test a restore regularly:

```bash
docker compose --env-file .env.production exec -T mongo \
  mongorestore --username root --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --archive --gzip --drop < backups/erp-YYYYMMDD-HHMM.archive.gz
```

## 7. Updates

```bash
git pull
docker compose --env-file .env.production up -d --build
```

## Moving later (MongoDB Atlas, AWS, another host)

- **Atlas:** create a cluster in the same region and one database user per service, as in `infra/docker/mongo/init.js`. Then set each service's `MONGO_URI` to the Atlas URI and remove the `mongo` and `mongo-init` services.
- **Another host:** copy `.env.production`, restore a backup, then run `docker compose up`.
