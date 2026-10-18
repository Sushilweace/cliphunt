import fs from 'node:fs';

export const ttsEnabled = () => !!process.env.OPENAI_API_KEY;

export async function speak(text, voice, outFile) {
  if (!ttsEnabled()) throw new Error('Text to speech needs OPENAI_API_KEY');
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.TTS_MODEL || 'tts-1', voice: voice || 'alloy', input: text.slice(0, 4000), response_format: 'mp3' }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 300)}`);
  fs.writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
}
