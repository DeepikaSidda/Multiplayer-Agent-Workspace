# Deploy to AWS EC2 (single instance, IAM-role auth for Bedrock)

The app runs as **one process on one port** (the Node server serves the built
client and handles `/api` + `/ws`). Your public link will be
`http://<EC2-Public-IPv4-DNS>` (or your domain with HTTPS).

There are two paths. **Path A (Docker, recommended)** is almost fully automated
via an EC2 user-data script. Path B runs Node directly with systemd + Nginx.

---

## Prerequisites (one-time, in the AWS console)

1. **Push this repo to a public GitHub repo** and copy its clone URL.
2. **IAM role for EC2** (so no static keys):
   - IAM → Roles → Create role → *AWS service → EC2*.
   - Inline policy:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
         "Resource": "*"
       }]
     }
     ```
   - Name it e.g. `maw-bedrock-role`.
3. **Enable model access**: Bedrock console → *Model access* → enable
   **Amazon Nova Pro** in the region you'll use.

---

## Path A — Docker via EC2 user data (recommended)

1. Edit `deploy/ec2-userdata.sh`: set `REPO_URL` and `AWS_REGION`.
2. EC2 → **Launch instance**:
   - AMI: **Amazon Linux 2023**; type: **t3.small** (needs ~2 GB to build).
   - **IAM instance profile:** `maw-bedrock-role`.
   - **Security group inbound:** `22` (your IP), `80` (anywhere).
   - **Advanced details → User data:** paste the contents of
     `deploy/ec2-userdata.sh`.
   - Launch.
3. Wait ~3–5 min for first boot to build the image. Then open
   **`http://<Public-IPv4-DNS>`**.

Check progress by SSHing in:
```bash
sudo cat /var/log/cloud-init-output.log   # bootstrap log
docker logs -f maw                        # app log
curl http://localhost/health              # {"ok":true,"agent":"nova-pro"}
```

Update after pushing new code:
```bash
cd /opt/maw && git pull && docker build -t maw:latest . \
  && docker rm -f maw \
  && docker run -d --name maw --restart always -p 80:8787 \
       -e AWS_REGION=<region> -e BEDROCK_REGION=<region> \
       -v /opt/maw-data:/data maw:latest
```

---

## Path B — Node + systemd + Nginx (no Docker)

SSH into the instance, then:
```bash
sudo dnf install -y git gcc-c++ make nginx
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs

git clone <your-repo-url> ~/maw && cd ~/maw
npm install
npm run build:deploy
cp .env.example .env      # set AWS_REGION=<region>; leave AWS keys blank (IAM role)

sudo cp deploy/maw.service /etc/systemd/system/maw.service
sudo systemctl daemon-reload && sudo systemctl enable --now maw

sudo cp deploy/nginx-maw.conf /etc/nginx/conf.d/maw.conf
sudo systemctl enable --now nginx && sudo nginx -s reload
```
Open **`http://<Public-IPv4-DNS>`**. Verify: `curl http://localhost:8787/health`.

---

## HTTPS (optional, gives a secure `wss://` link)

Point a domain's A record at the instance, then:
```bash
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com
```
The client auto-switches to `wss://` when the page is served over `https://`.

---

## Notes / caveats

- **Auth:** the WebSocket endpoint is unauthenticated — fine for a short public
  demo; take it down afterward. Add auth before any long-lived exposure.
- **Data:** SQLite persists to the mounted volume (`/opt/maw-data` in Docker,
  or `maw.db` in the working dir for Path B). It survives restarts, not
  instance termination.
- **Cost:** stop or terminate the instance when you're done.
