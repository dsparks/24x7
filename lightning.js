/* Shared thunderstorm lightning renderer for 24x7 and Ebb.
 * Call seedCell once when measuring/building a thunder cell, then drawCell each frame. */
(function(global){
  function fract(n){ return n - Math.floor(n); }
  function seeded(a, b, c, salt){
    return fract(Math.sin((a + 1) * 12.9898 + (b + 1) * 78.233 + (c + 1) * 37.719 + salt) * 43758.5453);
  }
  function seedCell(cell, day, hour){
    cell.flashDay = day || 0;
    cell.flashHour = hour || 0;
    cell.flashPhase = seeded(cell.flashDay, cell.flashHour, 0, 0);
    cell.flashRate = 0.085 + seeded(cell.flashDay, cell.flashHour, 1, 19.19) * 0.05;
  }
  function drawCell(ctx, time, cell, rect, opts){
    const rate = cell.flashRate || 0.11;
    const phase = cell.flashPhase || 0;
    const flashClock = time * rate + phase;
    const cycle = flashClock % 1;
    const env = Math.max(Math.exp(-cycle * 35), 0.65 * Math.exp(-Math.abs(cycle - 0.065) * 55));
    if (env <= 0.035) return false;

    const flashIndex = Math.floor(flashClock);
    const strikeX = seeded(cell.flashDay || 0, cell.flashHour || 0, flashIndex, 53.53);
    const x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    const settings = opts || {};

    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    if (settings.composite) ctx.globalCompositeOperation = settings.composite;
    ctx.fillStyle = `rgba(210,225,255,${((settings.flashAlpha ?? 0.18) * env).toFixed(3)})`;
    ctx.fillRect(x, y, w, h);

    const bx = x + w * (0.18 + 0.64 * strikeX);
    const by = y + h * 0.08;
    ctx.strokeStyle = `rgba(255,246,210,${((settings.boltAlpha ?? 0.8) * env).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.75, Math.min(1.6, w * 0.035));
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - w * 0.10, y + h * 0.34);
    ctx.lineTo(bx + w * 0.03, y + h * 0.48);
    ctx.lineTo(bx - w * 0.08, y + h * 0.72);
    ctx.stroke();
    ctx.restore();
    return true;
  }
  global.LightningFx = { seedCell, drawCell };
})(window);
