import { icon } from '../icons';
import type { PerformanceSession } from './session';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export function performancePlaybackLabel(playing: boolean): string {
  return `${icon(playing ? 'pause' : 'play')}<span>${playing ? 'Pause' : 'Play take'}</span>`;
}

/** Recording actions shared by camera and object controls. */
export function performancePanel(session: PerformanceSession, help: string, playing: boolean): string {
  const status = session.mode === 'record' ? `<span class="performance-recording-label">${icon('record')} Recording</span>`
    : session.mode === 'review' ? `<span class="performance-duration">${session.draft!.duration.toFixed(1)} s recorded</span>` : '';
  const header = `<div class="performance-heading"><div class="performance-subject">${icon(session.isCamera ? 'camera' : 'navigate')}<strong title="${escape(session.before.name)}">${escape(session.before.name)}</strong></div>${status}</div>`;

  if (session.mode === 'review') return header + `
    <div class="performance-actions"><div class="performance-action-group">
      <button data-performance="preview" title="Play / pause take · Space">${performancePlaybackLabel(playing)}</button>
      <button data-performance="retry" title="Discard this take and start recording again">${icon('retry')} Retake</button>
      <button data-performance="discard" class="icon-button" aria-label="Discard take" title="Discard this recording">${icon('trash')}</button>
    </div><div class="performance-action-group performance-primary-actions">
      <button data-performance="keep" class="performance-secondary">${icon('check')} Keep take</button>
      <button data-performance="refine" class="primary-button" title="Keep this take and attach it to Muse. You choose what to change before sending.">${icon('sparkles')} Refine with Muse</button>
    </div></div>`;

  const instructions = `<p class="performance-description">${escape(help)}</p>`;
  if (session.mode === 'record') return header + instructions + `
    <div class="performance-actions"><div class="performance-recording-status"><span class="performance-time-label">Scene time</span><span id="performanceClock" class="timecode"></span><span id="performanceMotionState" role="status"></span></div>
      <button data-performance="stop" class="record-button">${icon('stop')} Stop recording <kbd>R</kbd></button></div>`;

  return header + instructions + `
    <div class="performance-actions"><label class="performance-timing">${icon('clock')} Timing<select data-recording-clock aria-label="Recording timing" title="While moving pauses scene time whenever the controlled object or camera is still"><option value="realtime" ${session.clock === 'realtime' ? 'selected' : ''}>Real time</option><option value="motion" ${session.clock === 'motion' ? 'selected' : ''}>While moving</option></select></label>
      <div class="performance-action-group performance-primary-actions"><button data-performance="discard-position" class="icon-button" aria-label="Discard position and exit" title="Discard position and exit">${icon('trash')}</button><button data-performance="exit" title="Keep this position and stop controlling · Esc">Exit</button><button data-performance="record" class="primary-button">${icon('record')} Record <kbd>R</kbd></button></div>
    </div>`;
}
