import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { URL, URLSearchParams } from 'node:url';
import { DATA } from './store.js';

const YT_FILE = path.join(DATA, 'youtube.json');

/** Load stored YouTube connection data (tokens, channel info, custom credentials) */
export function loadYouTubeStore() {
  if (fs.existsSync(YT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(YT_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

/** Save YouTube connection data */
export function saveYouTubeStore(data) {
  const tmp = YT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, YT_FILE);
}

/** Clear YouTube tokens and disconnect channel */
export function disconnectYouTube() {
  const store = loadYouTubeStore();
  delete store.tokens;
  delete store.channel;
  saveYouTubeStore(store);
}

/** Get active client ID & Secret from store or .env */
export function getYouTubeCredentials() {
  const store = loadYouTubeStore();
  const clientId = process.env.YOUTUBE_CLIENT_ID || store.credentials?.clientId || '';
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || store.credentials?.clientSecret || '';
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || store.credentials?.redirectUri || '';
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri: redirectUri.trim() };
}

/** Save client ID & Secret into store */
export function saveYouTubeCredentials({ clientId, clientSecret, redirectUri }) {
  const store = loadYouTubeStore();
  store.credentials = {
    clientId: String(clientId || '').trim(),
    clientSecret: String(clientSecret || '').trim(),
    redirectUri: String(redirectUri || '').trim(),
  };
  saveYouTubeStore(store);
}

export function isYouTubeConfigured() {
  if (process.env.YOUTUBE_MOCK === '1') return true;
  const { clientId, clientSecret } = getYouTubeCredentials();
  return Boolean(clientId && clientSecret);
}

export function getYouTubeStatus() {
  const store = loadYouTubeStore();
  const configured = isYouTubeConfigured();
  const connected = (process.env.YOUTUBE_MOCK === '1') || Boolean(store.tokens?.refresh_token);
  return {
    configured,
    connected,
    channel: connected ? (store.channel || { title: 'Mock YouTube Channel', customUrl: '@mockcreator' }) : null,
    clientId: getYouTubeCredentials().clientId ? `${getYouTubeCredentials().clientId.slice(0, 12)}...` : null,
  };
}

/** Compute default redirect URI if not explicitly defined */
function resolveRedirectUri(reqHost, overrideUri) {
  if (overrideUri) return overrideUri;
  const creds = getYouTubeCredentials();
  if (creds.redirectUri) return creds.redirectUri;
  const host = reqHost || `localhost:${process.env.PORT || 3000}`;
  const proto = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return `${proto}://${host}/api/youtube/callback`;
}

/** Generate Google OAuth 2.0 Auth URL */
export function getYouTubeAuthUrl(reqHost, redirectUriOverride) {
  const { clientId } = getYouTubeCredentials();
  if (!clientId && process.env.YOUTUBE_MOCK !== '1') {
    throw new Error('YouTube Client ID is not configured. Add YOUTUBE_CLIENT_ID to .env or settings.');
  }

  const redirectUri = resolveRedirectUri(reqHost, redirectUriOverride);
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return { url: u.toString(), redirectUri };
}

/** Exchange code for tokens & fetch channel info */
export async function exchangeYouTubeCode(code, redirectUri) {
  if (process.env.YOUTUBE_MOCK === '1') {
    const store = loadYouTubeStore();
    store.tokens = { access_token: 'mock_token', refresh_token: 'mock_refresh', expiry_date: Date.now() + 3600000 };
    store.channel = { id: 'UC_MOCK_CHANNEL', title: 'Test Channel', customUrl: '@testcreator', thumbnail: '' };
    saveYouTubeStore(store);
    return store;
  }

  const { clientId, clientSecret } = getYouTubeCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Missing YouTube Client ID or Client Secret');
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Failed to exchange YouTube authorization code');
  }

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: Date.now() + ((data.expires_in || 3600) - 120) * 1000,
    scope: data.scope,
  };

  // Fetch channel info
  let channel = null;
  try {
    const cRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (cRes.ok) {
      const cData = await cRes.json();
      const item = cData.items?.[0];
      if (item) {
        channel = {
          id: item.id,
          title: item.snippet?.title || 'YouTube Channel',
          customUrl: item.snippet?.customUrl || '',
          thumbnail: item.snippet?.thumbnails?.default?.url || '',
        };
      }
    }
  } catch (err) {
    console.warn('[youtube] Failed to fetch channel details:', err.message);
  }

  const store = loadYouTubeStore();
  // Preserve refresh token if Google didn't resend one
  if (!tokens.refresh_token && store.tokens?.refresh_token) {
    tokens.refresh_token = store.tokens.refresh_token;
  }
  store.tokens = tokens;
  if (channel) store.channel = channel;
  saveYouTubeStore(store);
  return store;
}

/** Get a valid access token, refreshing if needed */
export async function getValidYouTubeAccessToken() {
  if (process.env.YOUTUBE_MOCK === '1') return 'mock_token';

  const store = loadYouTubeStore();
  const tokens = store.tokens;
  if (!tokens?.refresh_token) {
    throw new Error('YouTube is not connected. Please connect your YouTube account first.');
  }

  const now = Date.now();
  if (tokens.access_token && tokens.expiry_date && tokens.expiry_date > now) {
    return tokens.access_token;
  }

  // Refresh expired access token
  const { clientId, clientSecret } = getYouTubeCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Missing YouTube Client ID or Client Secret');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant') {
      disconnectYouTube();
      throw new Error('YouTube authorization expired or was revoked. Please reconnect your channel.');
    }
    throw new Error(data.error_description || data.error || 'Failed to refresh YouTube access token');
  }

  tokens.access_token = data.access_token;
  tokens.expiry_date = Date.now() + ((data.expires_in || 3600) - 120) * 1000;
  saveYouTubeStore(store);
  return tokens.access_token;
}

/**
 * Upload a Short to YouTube with optional predefined scheduled publish time.
 * @param {object} params
 * @param {string} params.filePath - Path to rendered vertical MP4
 * @param {string} params.title - Clip title
 * @param {string} params.description - Post description
 * @param {string[]} params.hashtags - List of hashtags
 * @param {string|null} [params.publishAt] - ISO 8601 datetime for scheduled publishing
 * @param {'public'|'unlisted'|'private'} [params.privacyStatus='public'] - Privacy status
 * @param {function} [params.onProgress] - Callback with percentage (0-100)
 */
export async function uploadShortToYouTube({
  filePath,
  title,
  description,
  hashtags = [],
  publishAt = null,
  privacyStatus = 'public',
  onProgress = null,
}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file does not exist: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  if (fileSize < 1000) {
    throw new Error('Video file is empty or corrupted');
  }

  // Mock upload mode
  if (process.env.YOUTUBE_MOCK === '1') {
    onProgress?.(30);
    await new Promise((r) => setTimeout(r, 100));
    onProgress?.(80);
    await new Promise((r) => setTimeout(r, 100));
    onProgress?.(100);
    const mockId = 'mock_' + Math.random().toString(36).slice(2, 9);
    return {
      id: mockId,
      videoUrl: `https://youtube.com/shorts/${mockId}`,
      publishAt: publishAt ? new Date(publishAt).toISOString() : null,
      privacyStatus: publishAt ? 'private' : privacyStatus,
      title,
    };
  }

  const accessToken = await getValidYouTubeAccessToken();

  // Prepare Short Title: Max 100 chars, ensure #Shorts is present
  let cleanTitle = String(title || 'Short Clip').trim();
  if (!cleanTitle.toLowerCase().includes('#shorts')) {
    cleanTitle = cleanTitle.slice(0, 91).trim() + ' #Shorts';
  } else {
    cleanTitle = cleanTitle.slice(0, 100);
  }

  // Prepare Tags: Clean strings without #
  const tags = Array.from(new Set([
    'Shorts',
    'shorts',
    ...hashtags.map((h) => String(h).replace(/^[#\s]+/, '').trim()).filter(Boolean),
  ])).slice(0, 30);

  // Prepare Description: Text + hashtags + #Shorts
  const hashList = Array.from(new Set([
    ...hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)),
    '#Shorts',
  ]));
  const fullDesc = `${String(description || '').trim()}\n\n${hashList.join(' ')}`.trim();

  // Determine privacy status and scheduling
  // YouTube API Rule: If status.publishAt is set, status.privacyStatus MUST be "private".
  let finalPrivacy = ['public', 'unlisted', 'private'].includes(privacyStatus) ? privacyStatus : 'public';
  let scheduledDate = null;
  if (publishAt) {
    const d = new Date(publishAt);
    if (isNaN(d.getTime())) {
      throw new Error('Invalid scheduled publish date format. Use ISO 8601.');
    }
    if (d.getTime() <= Date.now() + 60000) {
      throw new Error('Scheduled publish time must be at least 2 minutes in the future.');
    }
    scheduledDate = d.toISOString();
    finalPrivacy = 'private'; // Enforce private for scheduled videos
  }

  const metadata = {
    snippet: {
      title: cleanTitle,
      description: fullDesc,
      tags,
      categoryId: '22', // People & Blogs
    },
    status: {
      privacyStatus: finalPrivacy,
      ...(scheduledDate ? { publishAt: scheduledDate } : {}),
      selfDeclaredMadeForKids: false,
    },
  };

  // Step 1: Initiate Resumable Upload
  const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(fileSize),
    },
    body: JSON.stringify(metadata),
  });

  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => '');
    let errJson = {};
    try { errJson = JSON.parse(errText); } catch {}
    const msg = errJson.error?.message || errText;
    if (errJson.error?.errors?.some((e) => e.reason === 'quotaExceeded')) {
      throw new Error('YouTube daily upload quota exceeded (10,000 units/day limit reached). Wait for quota reset or request an increase.');
    }
    throw new Error(`YouTube upload initiation failed: ${msg}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('YouTube API did not return an upload URL');
  }

  // Step 2: Stream the video file bytes to the resumable upload URL
  return new Promise((resolve, reject) => {
    const parsed = new URL(uploadUrl);
    const client = parsed.protocol === 'http:' ? http : https;

    const req = client.request(
      parsed,
      {
        method: 'PUT',
        headers: {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4',
        },
      },
      (res) => {
        let respData = '';
        res.on('data', (c) => (respData += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const body = JSON.parse(respData);
              const videoId = body.id;
              resolve({
                id: videoId,
                videoUrl: `https://youtube.com/shorts/${videoId}`,
                publishAt: body.status?.publishAt || scheduledDate,
                privacyStatus: body.status?.privacyStatus || finalPrivacy,
                title: body.snippet?.title || cleanTitle,
              });
            } catch {
              resolve({
                id: null,
                raw: respData,
                publishAt: scheduledDate,
                privacyStatus: finalPrivacy,
                title: cleanTitle,
              });
            }
          } else {
            let errMsg = respData;
            try {
              const parsedErr = JSON.parse(respData);
              errMsg = parsedErr.error?.message || respData;
            } catch {}
            reject(new Error(`YouTube video upload failed (${res.statusCode}): ${errMsg}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(new Error(`Network error during YouTube upload: ${err.message}`)));

    const stream = fs.createReadStream(filePath);
    let sent = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      if (onProgress) {
        const pct = Math.min(99, Math.round((sent / fileSize) * 100));
        onProgress(pct);
      }
    });
    stream.pipe(req);
  });
}
