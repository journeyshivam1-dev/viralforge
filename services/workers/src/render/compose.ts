/**
 * Pure ffmpeg composition (no storage access) so it can be exercised in tests.
 * All file arguments are names relative to workDir; ffmpeg runs with cwd = workDir
 * so filter graphs never contain drive letters or backslashes.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { ScenePlan } from '@viralforge/domain';

const execFileAsync = promisify(execFile);
const FONT_NAME = process.env.RENDER_FONT_NAME || (process.platform === 'win32' ? 'Nirmala UI' : 'Noto Sans Devanagari');
const FONTS_DIR = process.env.RENDER_FONTS_DIR || '';
export const REEL = { width: 1080, height: 1920 };
export const POST = { width: 1080, height: 1350 };
const FPS = 30;
const AUDIO_TAIL_SECONDS = 0.35;

export interface SceneFiles {
  images: Map<number, string>;
  audio: Map<number, string>;
}

/** Renders reel to `${workDir}/final.mp4` and returns the total duration in seconds. */
export async function composeReel(scenes: ScenePlan[], files: SceneFiles, workDir: string, outName = 'final.mp4'): Promise<number> {
  const durations: number[] = [];
  for (const scene of scenes) {
    if (!files.images.has(scene.index)) throw new Error(`Scene ${scene.index} has no image`);
    const audio = files.audio.get(scene.index);
    const spoken = audio ? await probeDuration(path.join(workDir, audio)) : 0;
    durations.push(round(Math.max(scene.durationSeconds, spoken + AUDIO_TAIL_SECONDS, 1.5)));
  }
  const total = round(durations.reduce((sum, value) => sum + value, 0));
  const { promises: fs } = await import('fs');
  await fs.writeFile(path.join(workDir, 'captions.ass'), buildReelCaptions(scenes, durations), 'utf8');

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  const filters: string[] = [];
  let input = 0;
  scenes.forEach((scene, i) => {
    const frames = Math.ceil(durations[i] * FPS);
    args.push('-i', files.images.get(scene.index) as string);
    // Alternate zoom-in / zoom-out so consecutive scenes do not feel identical.
    const zoom = i % 2 === 0 ? `min(1+0.10*on/${frames},1.10)` : `max(1.10-0.10*on/${frames},1.0)`;
    filters.push(
      `[${input}:v]scale=${REEL.width * 2}:${REEL.height * 2}:force_original_aspect_ratio=increase,`
      + `crop=${REEL.width * 2}:${REEL.height * 2},`
      + `zoompan=z='${zoom}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${REEL.width}x${REEL.height}:fps=${FPS},`
      + `setsar=1,trim=duration=${durations[i]},setpts=PTS-STARTPTS[v${i}]`,
    );
    input += 1;
  });
  scenes.forEach((scene, i) => {
    const audio = files.audio.get(scene.index);
    if (audio) {
      args.push('-i', audio);
    } else {
      args.push('-f', 'lavfi', '-t', String(durations[i]), '-i', 'anullsrc=r=44100:cl=stereo');
    }
    filters.push(
      `[${input}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,`
      + `apad=whole_dur=${durations[i]},atrim=duration=${durations[i]},asetpts=PTS-STARTPTS[a${i}]`,
    );
    input += 1;
  });
  const pairs = scenes.map((_, i) => `[v${i}][a${i}]`).join('');
  filters.push(`${pairs}concat=n=${scenes.length}:v=1:a=1[cv][ca]`);
  filters.push(`[cv]${subtitlesFilter('captions.ass')},format=yuv420p[outv]`);
  filters.push('[ca]loudnorm=I=-16:TP=-1.5:LRA=11[outa]');

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart', '-t', String(total),
    outName,
  );
  await ffmpeg(args, workDir);
  return total;
}

/** Renders one 1080x1350 slide with headline/body overlay to `${workDir}/${outName}`. */
export async function composeSlide(scene: ScenePlan, image: string, position: number, total: number, brand: string, workDir: string, outName: string): Promise<void> {
  const { promises: fs } = await import('fs');
  const assName = `${path.parse(outName).name}.ass`;
  await fs.writeFile(path.join(workDir, assName), buildSlideOverlay(scene, position, total, brand), 'utf8');
  await ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', image,
    '-vf', `scale=${POST.width}:${POST.height}:force_original_aspect_ratio=increase,crop=${POST.width}:${POST.height},setsar=1,${subtitlesFilter(assName)}`,
    '-frames:v', '1', '-q:v', '2',
    outName,
  ], workDir);
}

// ---------------------------------------------------------------------------
// ASS subtitle builders
// ---------------------------------------------------------------------------

/** ASS treats {} as override blocks and \ as escapes; neutralise them in model text. */
export function assText(value: string): string {
  return value.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N').trim();
}

function assHeader(width: number, height: number, styles: string[]): string {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

function buildReelCaptions(scenes: ScenePlan[], durations: number[]): string {
  const header = assHeader(REEL.width, REEL.height, [
    // Yellow-on-dark-box caption in the lower third; the hook gets a larger top style.
    `Style: Caption,${FONT_NAME},68,&H0000F0FF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,3,14,0,2,80,80,420,1`,
    `Style: Hook,${FONT_NAME},84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,3,18,0,8,70,70,260,1`,
  ]);
  let cursor = 0;
  const events = scenes.map((scene, i) => {
    const start = cursor;
    cursor += durations[i];
    const textValue = assText(scene.onScreenText || scene.voiceover);
    if (!textValue) return '';
    const style = i === 0 ? 'Hook' : 'Caption';
    return `Dialogue: 0,${assTime(start)},${assTime(cursor)},${style},,0,0,0,,{\\fad(150,100)}${textValue}`;
  }).filter(Boolean);
  return `${header}\n${events.join('\n')}\n`;
}

function buildSlideOverlay(scene: ScenePlan, position: number, total: number, brand: string): string {
  const header = assHeader(POST.width, POST.height, [
    `Style: Headline,${FONT_NAME},76,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,3,20,0,2,70,70,250,1`,
    `Style: Body,${FONT_NAME},44,&H00F0F0F0,&H00FFFFFF,&H00000000,&HA0000000,0,0,0,0,100,100,0,0,3,14,0,2,80,80,110,1`,
    `Style: Brand,${FONT_NAME},30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,8,0,7,40,40,40,1`,
    `Style: Counter,${FONT_NAME},30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,8,0,9,40,40,40,1`,
  ]);
  const end = assTime(10);
  const lines = [
    `Dialogue: 0,${assTime(0)},${end},Headline,,0,0,0,,${assText(scene.onScreenText)}`,
    scene.bodyText ? `Dialogue: 0,${assTime(0)},${end},Body,,0,0,0,,${assText(scene.bodyText)}` : '',
    `Dialogue: 0,${assTime(0)},${end},Brand,,0,0,0,,${assText(brand)}`,
    total > 1 ? `Dialogue: 0,${assTime(0)},${end},Counter,,0,0,0,,${position}/${total}` : '',
  ].filter(Boolean);
  return `${header}\n${lines.join('\n')}\n`;
}

function assTime(seconds: number): string {
  const cs = Math.round(seconds * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------

/**
 * Uses the `ass` filter with complex shaping (HarfBuzz): the plain `subtitles`
 * filter renders Devanagari matras in the wrong position.
 */
function subtitlesFilter(fileName: string): string {
  const fontsDir = FONTS_DIR ? `:fontsdir=${FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:')}` : '';
  return `ass=${fileName}:shaping=complex${fontsDir}`;
}

export async function ffmpeg(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync('ffmpeg', args, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 10 * 60_000 });
  } catch (error: any) {
    const stderr = String(error.stderr || error.message || '').slice(-1500);
    throw Object.assign(new Error(`ffmpeg failed: ${stderr}`), { code: 'RENDER_FAILED' });
  }
}

export async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath]);
  const value = Number(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Could not read audio duration of ${path.basename(filePath)}`);
  return value;
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
