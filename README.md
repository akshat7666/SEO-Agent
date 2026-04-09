# SEO Agent

SEO Agent is an Express-based SEO and AEO audit app with a Tailwind landing page, crawl APIs, export endpoints, and PostgreSQL storage.

## Deploy On Railway

1. Create a new GitHub repository.
2. Push this project to that repository.
3. In Railway, create a new project from GitHub and select the repo.
4. Add a PostgreSQL service in Railway.
5. Set `DATABASE_URL` on the app service using the PostgreSQL connection string.
6. Run the SQL in `schema.sql` against the Railway Postgres database.
7. Deploy. Railway will start the app with `npm start` and check `/health`.

## Local Run

```bash
npm install
npm start
```

Required environment variables:

- `DATABASE_URL`
- `PORT` is optional locally and is provided automatically by Railway in production

## Git Remote Switch

To point this project at your new repository:

```bash
git remote set-url origin https://github.com/akshat7666/SEO-Agent.git
git branch -M main
git add .
git commit -m "Prepare project for Railway deployment"
git push -u origin main
```

## Notes

- The app starts as a normal long-running server, which is what Railway expects.
- Playwright is used for rendered extraction, so the deployment should allow the postinstall browser setup to complete.
