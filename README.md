# Studio Rhys website

Plain HTML and CSS. No build step, no dependencies. Hosted on Cloudflare Pages.

## What's where

| File or folder | What it is |
| --- | --- |
| `index.html` | Landing page (studio-rhys.com) |
| `about.html` | About page (studio-rhys.com/about) |
| `services.html` | Services page (studio-rhys.com/services) |
| `404.html` | Shown for any address that doesn't exist |
| `css/style.css` | All styles, shared by every page |
| `fonts/` | Atkinson Hyperlegible Next and Mono, self-hosted (SIL Open Font License, licence files included) |
| `images/` | Photos (800px and 1400px versions of each) |
| `images/logos/` | Logo banner |
| `og-image.png` | Link preview image for LinkedIn, WhatsApp, Slack and X |
| `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest` | Browser tab and home-screen icons |
| `_headers` | Cloudflare Pages caching and security headers |
| `robots.txt`, `sitemap.xml` | For search engines |

Cloudflare Pages serves `about.html` at `/about` automatically, so links in the pages use `/about` and `/services`.

The header, nav and footer are repeated in each page. If you change them, change all four HTML files.

## Going live

### 1. Put the files in the repo

Replace everything in `rhys-the-davies/studiorhys-site` with the contents of this folder (keep the hidden `.git` folder). Push to a new branch first, for example `new-site`, so you can check a preview before anything replaces the live site.

### 2. Create the Cloudflare Pages project

1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Sign in to GitHub, pick `studiorhys-site`, then **Install & Authorize** → **Begin setup**.
3. Build settings:
   - Framework preset: **None**
   - Build command: **leave blank**
   - Build output directory: **/** (the files sit at the top of the repo)
   - Production branch: **main**
4. Save and deploy. Every branch other than `main` gets its own preview address, so the `new-site` branch shows the new site at a `…pages.dev` link while studio-rhys.com is untouched.

Source: [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/)

### 3. Check the preview

Click through every page on the preview link, on a laptop and a phone. Tap each "Get in touch" and coffee button to check the email opens addressed to rhys@studio-rhys.com.

### 4. Switch the domain

1. Merge `new-site` into `main`. Cloudflare deploys it to the project's main `pages.dev` address.
2. In the Pages project → **Custom domains** → **Set up a custom domain** → enter `studio-rhys.com`. Repeat for `www.studio-rhys.com`.
3. Cloudflare updates the DNS for you. If it reports that a record already exists, delete the old A record pointing at `76.76.21.21` (that's Vercel) in the DNS tab and try again.
4. Once studio-rhys.com shows the new site, remove the domain from the Vercel project and delete or disconnect that project, so pushes stop deploying to Vercel.

### 5. After launch

- Paste studio-rhys.com into [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) to check the preview card and clear any old cached preview.
- Add the site to [Google Search Console](https://search.google.com/search-console) and submit `https://studio-rhys.com/sitemap.xml`.

## Changing things later

- **Copy:** edit the text in the relevant HTML file and push. Cloudflare redeploys in about a minute.
- **Photos:** replace the files in `images/` with the same names, or add new ones and update the `src` and `srcset` in the HTML. Browsers cache images for a week, so give a replacement a new name if you want everyone to see it straight away.
- **Case studies:** the "Read more" link under Case studies on the landing page is commented out in `index.html`. Uncomment it when a `case-studies.html` page exists.
