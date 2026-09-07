# BRL Command Center — deploy to your VPS (103.168.19.182)

This targets the setup you already have: Ubuntu VPS, Nginx, PM2, Node.js.
No Supabase/Firebase signup needed — storage is 3 JSON files on your own server.

## 1. Upload the project
From your local machine (or wherever this folder is):
```
scp -r brl-command-center your-ssh-user@103.168.19.182:/var/www/brl-cc
```

## 2. On the VPS: install deps and set passwords
```
ssh your-ssh-user@103.168.19.182
cd /var/www/brl-cc
npm install --production
cp .env.example .env
nano .env      # set PASS_SUYASHH and PASS_JAGRUTI to real strong passwords
```

## 3. Run it with PM2
```
pm2 start server.js --name brl-cc --env-file .env
pm2 save
```
(If your PM2 version doesn't support `--env-file`, use `pm2 start server.js --name brl-cc` and instead export the vars in `~/.bashrc` or use a small wrapper — ask me and I'll adjust `server.js` to load `.env` with `dotenv` if you'd rather.)

Check it's up:
```
curl -u suyashh:<your-password> http://127.0.0.1:4001/
```

## 4. Point Nginx at it
Create `/etc/nginx/sites-available/brl-cc`:
```nginx
server {
    listen 80;
    server_name cc.bestroadways.com;   # or the VPS IP if no subdomain yet

    location / {
        proxy_pass http://127.0.0.1:4001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
Enable it:
```
sudo ln -s /etc/nginx/sites-available/brl-cc /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 5. Add a DNS record + HTTPS
In your domain's DNS, add an A record: `cc` → `103.168.19.182`.
Then:
```
sudo certbot --nginx -d cc.bestroadways.com
```
Certbot rewrites the Nginx block to redirect HTTP → HTTPS automatically.

## 6. Open it
`https://cc.bestroadways.com` — the browser will pop its native login box.
Log in as `suyashh` or `jagruti` with the passwords from `.env`. That's it —
leads/activity/settings now live in `/var/www/brl-cc/data/*.json` on your
server and survive restarts, browser changes, and device changes.

## Restart / logs
```
pm2 restart brl-cc
pm2 logs brl-cc
```

## Backups
Every write auto-snapshots the day's first version into `data/backups/`.
For extra safety, add a cron job to copy `data/` off-box weekly:
```
0 3 * * 0 tar czf /root/backups/brl-cc-$(date +\%F).tar.gz -C /var/www/brl-cc data
```

## What's NOT included yet (from the original dev guide)
Everything above gets you a fully working, persistent, password-protected app —
that's "Day 1" of the guide's build order. Not yet wired up (all optional,
backend routes to add later):
- `/api/send-wa` → Maytapi proxy (WhatsApp auto-send + hides the API key)
- `/api/send-email` → Gmail API send (currently uses `mailto:`, which already works fine)
- Runo call-log sync cron
- Scheduled digest/EOD/chase emails (§5 of the dev guide)

Say the word and I'll build any of these next — the Maytapi proxy is the
highest-value one since it's a small addition to `server.js`.
