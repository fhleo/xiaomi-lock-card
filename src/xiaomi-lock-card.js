/**
 * xiaomi-lock-card
 * 鹿客智能锁只读监控卡片 —— 纯事件驱动，零依赖
 *
 * 数据源：sensor.lu_ke_suo_ri_zhi（模板日志）+ 各 binary_sensor
 * 布局：头部(设备名+电量) / 中央锁图标+徽章 / 状态行 / 统计条 / 记录列表(分组+筛选+日历)
 */

const ICONS = {
  fp:    '<path d="M12 2C7 2 3.5 6 3.5 11c0 3.5 1.5 6.5 3 9"/><path d="M12 6c-3.5 0-6 3-6 6.5 0 2.5 1 4.5 2 6.5"/><path d="M12 10c-1.5 0-2.5 1.2-2.5 3s.7 3 1.5 4.5"/>',
  pw:    '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  lock:  '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  x:     '<path d="M6 6 L18 18"/><path d="M18 6 L6 18"/>',
  bell:  '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>',
  dot:   '<circle cx="12" cy="12" r="7"/>',
  shield:'<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pad:   '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M12 7v3"/>',
  cal:   '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'
};

const CAT_CLASS = { unlock:'', lock:'info', fail:'bad', bell:'bell', other:'plain' };

/* 本地日期 → YYYY-MM-DD（禁止 toISOString，那是 UTC） */
function isoLocal(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

class XiaomiLockCard extends HTMLElement {
  constructor(){
    super();
    this._records = [];            // 已解析日志记录
    this._lastUnlock = null;       // 最近外部开锁 {text, when, ts}
    this._todayCount = 0;
    this._histCache = null;        // {ts, data}
    this._histInflight = false;
    this._histTimer = null;        // 日志变化后的延迟刷新（合并连续事件）
    this._prev = {};               // 上次快照 {entityId: {st, lc}}
    this._live = [];               // 已推送但历史接口尚未返回的记录（防止最新一条被整表重绘抹掉）
    this._resetTimer = null;
    this._calYear = null;
    this._calMonth = null;
    this._calTarget = null;
    this._currentFilter = 'all';
    this._startDate = '';
    this._endDate = '';
  }

  /* ================= 配置 ================= */
  setConfig(config){
    if(!config || !config.log) throw new Error('xiaomi-lock-card: 必须配置 log 实体');
    const changed = this._config && JSON.stringify(this._config) !== JSON.stringify(config);
    this._config = config;
    this._cfg = {
      log:         config.log,
      title:       config.title || '',
      locked:      config.locked || '',
      arm:         config.arm || '',
      child:       config.child || '',
      battery:     config.battery || null,
      // 兼容 DESIGN §7 里的 battery.low，以及平铺的顶层 low
      low:         (config.battery && config.battery.low !== undefined) ? config.battery.low
                 : (config.low !== undefined ? config.low : 20),
      records:     Object.assign({ days:2, limit:5, refresh:60, events:'all', include_internal:false }, config.records),
      showRecords: config.show_records !== false,
      tapAction:   config.tap_action || 'more-info',
      failWords:   (config.fingerprint_result && config.fingerprint_result.fail) || ['失败','错误','拒绝','未识别'],
      theme:       config.theme || 'dark'
    };

    // UI 编辑器保存后 HA 会对同一个已挂载的元素再次调用 setConfig。
    // 若不重新套用配置，卡片仍显示旧标题/旧主题/旧记录区 → 表现为「UI 与 YAML 不同步」。
    if(changed && this._el){
      this._applyConfig();
      this._prev = {};                 // 强制下次 hass 全量套用
      if(this._hass) this._diffHass(this._hass);
    }
  }

  /* 把 _cfg 里与 DOM 有关的部分套用到已构建的界面上 */
  _applyConfig(){
    const c = this._cfg, e = this._el;
    if(!e) return;

    e.title.textContent = c.title || '指纹锁';
    e.battGroup.style.display = (c.battery && (c.battery.primary || c.battery.secondary)) ? 'flex' : 'none';
    e.records.style.display   = c.showRecords ? '' : 'none';
    e.card.classList.toggle('light', this._isLight());
  }

  /* theme: dark | light | auto
     auto = 跟随 Home Assistant 的深浅主题配置（hass.themes.darkMode），与操作系统无关 ——
     卡片永远和仪表盘保持一致。HA 自身若设为「跟随系统」，该值本就是由系统算出来的。
     只有在拿不到 hass（独立预览页等）时，才退回操作系统的 prefers-color-scheme。 */
  _isLight(){
    const t = this._cfg.theme;
    if(t === 'light') return true;
    if(t !== 'auto') return false;
    return !this._isDark();
  }

  /* HA 认定的深色；没有 hass 时才用系统媒体查询兜底 */
  _isDark(){
    const d = (this._hass && this._hass.themes) ? this._hass.themes.darkMode : undefined;
    if(typeof d === 'boolean') return d;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  getCardSize(){ return 5; }

  /* Lovelace 可视化配置面板入口 */
  static getConfigElement(){
    return document.createElement('xiaomi-lock-card-editor');
  }

  /* 卡片右键菜单项 */
  static getStubConfig(hass){
    const log = hass && Object.keys(hass.states || {})
      .find(id => id.startsWith('sensor.') && /日志|log|lock/i.test(id));
    return {
      type: 'custom:xiaomi-lock-card',
      log: log || ''
    };
  }

  /* ================= 生命周期 ================= */
  connectedCallback(){
    if(!this._el){                 // 防止断开重连时重复 attachShadow
      this._build();
      this._bindEvents();
    }
    // theme=auto 的兜底：拿不到 hass.themes.darkMode 时才用系统深浅色，切换时重新套用
    if(window.matchMedia && !this._mql){
      this._mql = window.matchMedia('(prefers-color-scheme: dark)');
      this._onSysTheme = () => { if(this._cfg && this._cfg.theme === 'auto') this._applyConfig(); };
      if(this._mql.addEventListener) this._mql.addEventListener('change', this._onSysTheme);
      else if(this._mql.addListener) this._mql.addListener(this._onSysTheme);
    }
    // 若 hass 在插入 DOM 前就已赋值，这里补一次首次渲染
    if(this._hass){
      this._prev = {};             // 强制全量刷新，不走 diff
      this._diffHass(this._hass);
    }
    this._fetchHistory();
  }

  disconnectedCallback(){
    clearTimeout(this._resetTimer);
    clearTimeout(this._histTimer);
    if(this._mql && this._onSysTheme){
      if(this._mql.removeEventListener) this._mql.removeEventListener('change', this._onSysTheme);
      else if(this._mql.removeListener) this._mql.removeListener(this._onSysTheme);
      this._mql = null;
    }
  }

  set hass(hass){
    const prevDark = this._darkNow;
    this._hass = hass;
    /* 记住 HA 当前的深浅判定，用于检测主题切换 */
    this._darkNow = (hass && hass.themes && typeof hass.themes.darkMode === 'boolean')
                  ? hass.themes.darkMode : undefined;
    // 元素尚未插入 DOM 时（HA 会在 setConfig 后立即赋 hass），_el 还不存在
    if(!this._el) return;
    /* theme=auto：HA 深浅配置一变就重新套用（首次拿到 hass 也走这里） */
    if(this._cfg && this._cfg.theme === 'auto' && prevDark !== this._darkNow) this._applyConfig();
    this._diffHass(hass);
  }

  /* ================= 构建 DOM ================= */
  _build(){
    const sr = this.attachShadow({ mode:'open' });
    sr.innerHTML = `
<style>
${this._css()}
</style>
<div class="card">
  <!-- ① 头部 -->
  <header class="head">
    <div class="head-left">
      <div class="head-icon" id="headIcon">
        <svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.6" fill="currentColor" stroke="none"/></svg>
      </div>
      <div style="min-width:0"><h2 id="cardTitle"></h2></div>
    </div>
  </header>

  <!-- 电量：卡片右上角 -->
  <div class="batt-group" id="battGroup" style="display:none">
    <button class="batt" id="battBig" title="大电池"><span class="bar"></span><span class="t"></span></button>
    <button class="batt" id="battSmall" title="小电池"><span class="bar"></span><span class="t"></span></button>
  </div>

  <!-- ② 主视觉：锁图标 + 徽章 -->
  <section class="hero">
    <div class="lockwrap" id="lockWrap" data-state="locked">
      <span class="pulse"></span>
      <svg class="lock" viewBox="0 0 120 120">
        <path class="shackle" d="M42 58 V40 A18 18 0 0 1 78 40 V58"/>
        <rect class="body" x="26" y="58" width="68" height="50" rx="13"/>
        <circle class="key" cx="60" cy="76" r="5.5"/>
        <path class="keyline" d="M60 82 V91"/>
      </svg>
      <span class="badge locked" id="badge">—</span>
    </div>
  </section>

  <!-- ③ 状态行 -->
  <div class="status" id="status">
    <span class="sdot"></span>
    <span class="stext" id="statusText">尚无外部开锁记录</span>
    <span class="ts" id="statusTs"></span>
  </div>

  <!-- ④ 统计条 -->
  <div class="tiles">
    <div class="tile st" id="armTile">
      <span class="t-ic"><svg viewBox="0 0 24 24">${ICONS.shield}</svg></span>
      <span class="t-lab">布防状态</span>
      <span class="t-val mut" id="armVal">—</span>
    </div>
    <div class="tile st">
      <span class="t-ic"><svg viewBox="0 0 24 24">${ICONS.clock}</svg></span>
      <span class="t-lab">今日开锁</span>
      <span class="t-val" id="todayVal">0<small>次</small></span>
    </div>
    <div class="tile st" id="childTile">
      <span class="t-ic"><svg viewBox="0 0 24 24">${ICONS.pad}</svg></span>
      <span class="t-lab">童锁</span>
      <span class="t-val mut" id="childVal">—</span>
    </div>
  </div>

  <!-- ⑤ 记录列表 -->
  <div class="records" id="records">
    <div class="rec-head">
      <h3>最近日志</h3>
      <div class="filter">
        <button id="filterBtn">筛选 ▾</button>
        <div class="filter-menu" id="filterMenu">
          <button data-filter="all" class="active">全部</button>
          <button data-filter="date">按日期</button>
          <button data-filter="alert">告警</button>
          <button data-filter="unlock">开门</button>
          <button data-filter="lock">关门</button>
        </div>
      </div>
    </div>
    <div class="rec-date-picker" id="datePicker">
      <div class="date-range">
        <button class="date-btn" id="startDateBtn">
          <svg viewBox="0 0 24 24">${ICONS.cal}</svg>
          <span id="startDateText">起始日期</span>
        </button>
        <span class="date-sep">→</span>
        <button class="date-btn" id="endDateBtn">
          <svg viewBox="0 0 24 24">${ICONS.cal}</svg>
          <span id="endDateText">结束日期</span>
        </button>
      </div>
      <div class="calendar-pop" id="calendarPop">
        <div class="cal-header">
          <button class="cal-prev" id="calPrev">‹</button>
          <span class="cal-title" id="calTitle"></span>
          <button class="cal-next" id="calNext">›</button>
        </div>
        <div class="cal-grid" id="calGrid">
          <span class="cal-dow">日</span><span class="cal-dow">一</span><span class="cal-dow">二</span><span class="cal-dow">三</span><span class="cal-dow">四</span><span class="cal-dow">五</span><span class="cal-dow">六</span>
        </div>
      </div>
    </div>
    <div class="rec-list" id="recList"></div>
    <!-- 筛选无结果时占位：既给出反馈，也撑住卡片高度，
         否则 .rec-list 塌成 0 会让卡片骤然变矮，.filter-menu 下半截
         被 .card{overflow:hidden} 裁掉，导致其余选项点不到。 -->
    <div class="rec-empty" id="recEmpty" hidden>无匹配记录</div>
  </div>
</div>`;

    // 缓存元素引用
    const $ = id => sr.getElementById(id);
    this._el = {
      card: sr.querySelector('.card'),
      title: $('cardTitle'), headIcon: $('headIcon'),
      battGroup: $('battGroup'), battBig: $('battBig'), battSmall: $('battSmall'),
      lockWrap: $('lockWrap'), badge: $('badge'),
      status: $('status'), statusText: $('statusText'), statusTs: $('statusTs'),
      armTile: $('armTile'), armVal: $('armVal'),
      todayVal: $('todayVal'), childTile: $('childTile'), childVal: $('childVal'),
      records: $('records'), recList: $('recList'), recEmpty: $('recEmpty'),
      filterBtn: $('filterBtn'), filterMenu: $('filterMenu'),
      datePicker: $('datePicker'),
      startDateBtn: $('startDateBtn'), endDateBtn: $('endDateBtn'),
      startDateText: $('startDateText'), endDateText: $('endDateText'),
      calendarPop: $('calendarPop'), calTitle: $('calTitle'), calGrid: $('calGrid'),
      calPrev: $('calPrev'), calNext: $('calNext')
    };

    // 标题 / 电量 / 记录区 / 主题 统一由配置套用
    this._applyConfig();
  }

  _css(){ return `
  :host{--bg-deep:#0a0e13;--surface:#141b23;--line:rgba(0,229,255,.16);--accent:#00e5ff;--accent-2:#4d7cff;--info:#7fa7ff;--success:#00e676;--danger:#ff5252;--warn:#ffb300;--text:#e6edf3;--muted:#8b98a5;--mono:ui-monospace,"Cascadia Mono",Consolas,"Courier New",monospace}
  *{box-sizing:border-box;margin:0;padding:0}
  .card{position:relative;z-index:0;width:100%;border-radius:22px;padding:20px 20px 16px;background:linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px),linear-gradient(160deg,#161e27 0%,#0d1218 55%,#0a0e13 100%);background-size:24px 24px,24px 24px,100% 100%;border:1px solid var(--line);box-shadow:0 24px 60px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.05);overflow:hidden;font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--text)}
  .head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px 4px 0;min-height:36px}
  .head-left{display:flex;align-items:center;gap:11px;min-width:0;flex:1;padding-right:96px}
  .head-icon{flex:none;width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(145deg,rgba(0,229,255,.16),rgba(77,124,255,.1));border:1px solid rgba(0,229,255,.3);box-shadow:0 0 14px rgba(0,229,255,.15) inset}
  .head-icon svg{width:19px;height:19px;stroke:var(--accent);fill:none;stroke-width:1.8}
  .head-icon.ring{animation:bellRing .55s ease-in-out 2}
  @keyframes bellRing{0%,100%{transform:rotate(0)}25%{transform:rotate(-10deg)}75%{transform:rotate(10deg)}}
  .head h2{font-size:16.5px;font-weight:650;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .badge{flex:none;font-size:11.5px;font-weight:600;letter-spacing:.06em;transition:.3s}
  .badge.locked{color:var(--info)}.badge.unlocked{color:var(--success)}
  .hero{display:flex;align-items:center;justify-content:center;padding:18px 0 6px;clear:both}
  .lockwrap{position:relative;width:158px;height:158px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;isolation:isolate}
  .lockwrap::before{content:"";position:absolute;inset:0;border-radius:50%;border:1px solid rgba(0,229,255,.22);background:radial-gradient(circle at 50% 45%,rgba(0,229,255,.09),rgba(10,14,19,.4) 70%);transition:border-color .4s,background .4s,box-shadow .4s}
  .lockwrap::after{content:"";position:absolute;inset:-7px;border-radius:50%;border:1px dashed rgba(0,229,255,.2);border-top-color:transparent;border-bottom-color:transparent;animation:spin 14s linear infinite}
  .lock{width:84px;height:84px;position:relative;z-index:2;overflow:visible;stroke:var(--info);transition:stroke .45s,filter .45s;animation:breathe 4.5s ease-in-out infinite}
  .lock .shackle{fill:none;stroke-width:9;stroke-linecap:round;transform-origin:42px 58px;transition:transform .5s cubic-bezier(.34,1.56,.64,1)}
  .lock .body{fill:rgba(8,11,15,.92);stroke-width:7}
  .lock .key{fill:none;stroke-width:6;stroke-linecap:round}
  .lock .keyline{stroke-width:6;stroke-linecap:round}
  @keyframes breathe{50%{opacity:.72}}
  .lockwrap[data-state="unlocked"]::before{border-color:rgba(0,230,118,.5);background:radial-gradient(circle at 50% 45%,rgba(0,230,118,.16),transparent 70%);box-shadow:0 0 34px rgba(0,230,118,.3) inset,0 0 26px rgba(0,230,118,.28)}
  .lockwrap[data-state="unlocked"] .lock{stroke:var(--success);filter:drop-shadow(0 0 8px rgba(0,230,118,.55))}
  .lockwrap[data-state="unlocked"] .shackle{transform:rotate(-16deg)}
  .lockwrap[data-state="unlocked"] .pulse{animation:pulse .9s ease-out .15s}
  .lockwrap.shake{animation:shake .45s cubic-bezier(.36,.07,.19,.97) both}
  .lockwrap.shake::before{border-color:rgba(255,82,82,.55);background:radial-gradient(circle at 50% 45%,rgba(255,82,82,.14),transparent 70%)}
  .lockwrap.shake .lock{stroke:var(--danger);filter:drop-shadow(0 0 8px rgba(255,82,82,.7))}
  .pulse{position:absolute;inset:0;border-radius:50%;border:2px solid var(--success);opacity:0;z-index:1}
  @keyframes pulse{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.45)}}
  @keyframes shake{10%,90%{transform:translateX(-2px)}20%,80%{transform:translateX(4px)}30%,50%,70%{transform:translateX(-7px)}40%,60%{transform:translateX(7px)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes blink{50%{opacity:.45}}
  .batt-group{position:absolute;top:30px;right:16px;z-index:5;display:flex;align-items:flex-end;gap:11px;pointer-events:none}
  .batt-group .batt{pointer-events:auto}
  .batt{display:flex;align-items:flex-end;gap:6px;padding:0;cursor:pointer;background:none;border:none}
  .batt .bar{width:3px;border-radius:2px;background:var(--accent);box-shadow:0 0 7px var(--accent);transition:background .3s,box-shadow .3s,height .6s ease}
  .batt .t{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--accent);letter-spacing:.02em;text-shadow:0 1px 3px rgba(0,0,0,.9);transition:color .3s}
  .batt.warn .bar{background:var(--warn);box-shadow:0 0 7px var(--warn)}.batt.warn .t{color:var(--warn)}
  .batt.low .bar{background:var(--danger);box-shadow:0 0 7px var(--danger)}.batt.low .t{color:var(--danger)}
  .lockwrap .badge{font-size:12px;margin-top:2px}
  .bump{animation:bump .5s cubic-bezier(.34,1.56,.64,1)}
  .status{display:flex;align-items:center;gap:9px;margin:10px 4px 0;padding:10px 14px;border-radius:13px;background:rgba(8,11,15,.66);border:1px solid rgba(255,255,255,.055);transition:border-color .3s}
  .status .sdot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--muted);box-shadow:0 0 8px currentColor;color:var(--muted);transition:background .3s,color .3s}
  .status .stext{flex:1;font-size:13.5px;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .status .ts{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.03em}
  .status.ok .sdot{background:var(--success);color:var(--success)}.status.ok .stext{color:var(--success)}
  .status.err .sdot{background:var(--danger);color:var(--danger)}.status.err .stext{color:var(--danger)}
  .status.busy .sdot{background:var(--accent);color:var(--accent)}.status.busy .stext{color:var(--accent)}
  .status.info .sdot{background:var(--info);color:var(--info)}.status.info .stext{color:var(--info)}
  .tiles{display:flex;gap:9px;margin-top:12px}
  .tile{flex:1;min-width:0;padding:10px 8px 9px;border-radius:13px;text-align:center;background:rgba(8,11,15,.66);border:1px solid rgba(255,255,255,.055);cursor:pointer;transition:border-color .2s,background .2s}
  .tile:hover{border-color:rgba(0,229,255,.4);background:rgba(0,229,255,.05)}
  .tile .t-lab{display:block;font-size:10px;color:var(--muted);letter-spacing:.18em;margin-bottom:5px}
  .tile .t-val{font-family:var(--mono);font-size:14.5px;font-weight:600;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;line-height:1.15}
  .tile .t-val.unset{font-size:13px}
  .tile .t-val small{font-size:10px;color:var(--muted);font-weight:400;margin-left:1px}
  .tile .t-val.ok{color:var(--success)}.tile .t-val.mut{color:var(--muted)}
  .tile.st .t-ic{display:grid;place-items:center;width:32px;height:32px;margin:0 auto 7px;border-radius:10px;color:var(--muted);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);transition:.3s}
  .tile.st .t-ic svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .tile.st.on .t-ic{color:var(--success);background:rgba(0,230,118,.1);border-color:rgba(0,230,118,.4);box-shadow:0 0 14px rgba(0,230,118,.25)}
  .tile.st.on .t-val{color:var(--success)}
  @keyframes bump{0%{transform:scale(1)}40%{transform:scale(1.28);color:var(--success)}100%{transform:scale(1)}}
  .records{margin-top:15px;border-top:1px solid rgba(255,255,255,.07);padding-top:13px}
  .rec-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
  .rec-head h3{font-size:11.5px;font-weight:600;color:var(--muted);letter-spacing:.22em;text-transform:uppercase}
  .filter{position:relative}
  .filter>button{font-size:11.5px;color:var(--accent);cursor:pointer;letter-spacing:.08em;opacity:.85;background:none;border:none;padding:0}
  .filter>button:hover{opacity:1;text-shadow:0 0 8px rgba(0,229,255,.6)}
  .filter-menu{display:none;position:absolute;right:0;top:calc(100% + 6px);z-index:20;min-width:110px;background:rgba(10,14,19,.97);border:1px solid rgba(0,229,255,.25);border-radius:10px;padding:5px;box-shadow:0 10px 30px rgba(0,0,0,.6)}
  .filter-menu.open{display:block;animation:slideDown .25s cubic-bezier(.2,.9,.3,1)}
  /* 下方空间不足时翻到按钮上方，避免被 .card{overflow:hidden} 裁掉 */
  .filter-menu.up{top:auto;bottom:calc(100% + 6px)}
  .filter-menu button{display:block;width:100%;text-align:left;font-size:12px;color:var(--text);padding:7px 10px;border-radius:7px;background:none;border:none;cursor:pointer;letter-spacing:.04em}
  .filter-menu button:hover{background:rgba(0,229,255,.1)}
  .filter-menu button.active{color:var(--accent);background:rgba(0,229,255,.12)}
  .rec-date-picker{display:none;padding:2px 0 6px}
  .rec-date-picker.open{display:block}
  .date-range{display:flex;align-items:center;gap:8px}
  .date-btn{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:6px;background:rgba(8,11,15,.8);border:1px solid rgba(0,229,255,.25);border-radius:8px;color:var(--text);font-family:var(--mono);font-size:12px;padding:7px 10px;cursor:pointer;transition:border-color .2s}
  .date-btn:hover{border-color:rgba(0,229,255,.5)}
  .date-btn svg{width:14px;height:14px;stroke:var(--accent);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .date-btn.filled{color:var(--accent);border-color:rgba(0,229,255,.5)}
  .date-sep{color:var(--muted);font-size:12px;flex:none}
  .calendar-pop{display:none;margin-top:8px;background:rgba(10,14,19,.97);border:1px solid rgba(0,229,255,.25);border-radius:10px;padding:10px;box-shadow:0 10px 30px rgba(0,0,0,.6)}
  .calendar-pop.open{display:block;animation:slideDown .2s cubic-bezier(.2,.9,.3,1)}
  .cal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .cal-header button{background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;padding:2px 8px;border-radius:6px;line-height:1}
  .cal-header button:hover{background:rgba(0,229,255,.1)}
  .cal-title{font-size:12px;color:var(--text);font-family:var(--mono);letter-spacing:.05em}
  .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
  .cal-dow{font-size:10px;color:var(--muted);text-align:center;padding:4px 0}
  .cal-day{font-size:11px;color:var(--text);text-align:center;padding:6px 0;border-radius:6px;cursor:pointer;font-family:var(--mono);transition:background .15s}
  .cal-day:hover{background:rgba(0,229,255,.15)}
  .cal-day.empty{cursor:default;background:none}
  .cal-day.selected{background:var(--accent);color:#06121a;font-weight:700}
  .cal-day.in-range{background:rgba(0,229,255,.2)}
  .rec-list{max-height:190px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(0,229,255,.3) transparent}
  .rec-list::-webkit-scrollbar{width:4px}
  .rec-list::-webkit-scrollbar-thumb{background:rgba(0,229,255,.3);border-radius:2px}
  .rec-empty{display:flex;align-items:center;justify-content:center;height:170px;margin-top:4px;border:1px dashed rgba(0,229,255,.18);border-radius:11px;color:var(--muted);font-size:12.5px;letter-spacing:.16em;user-select:none}
  .rec-empty[hidden]{display:none}
  .rec-group{font-size:10px;color:var(--muted);letter-spacing:.18em;padding:8px 6px 3px;text-transform:uppercase}
  .rec-group:first-child{padding-top:2px}
  .rec{display:flex;align-items:center;gap:12px;padding:9px 6px;border-radius:11px;transition:background .2s;cursor:pointer}
  .rec:hover{background:rgba(255,255,255,.045)}
  .rec+.rec{border-top:1px solid rgba(255,255,255,.045)}
  .rec-ic{flex:none;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:rgba(0,230,118,.11);border:1px solid rgba(0,230,118,.3)}
  .rec-ic svg{width:15px;height:15px;stroke:var(--success);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .rec.bad .rec-ic{background:rgba(255,82,82,.11);border-color:rgba(255,82,82,.35)}.rec.bad .rec-ic svg{stroke:var(--danger)}
  .rec.info .rec-ic{background:rgba(127,167,255,.1);border-color:rgba(127,167,255,.3)}.rec.info .rec-ic svg{stroke:var(--info)}
  .rec.bell .rec-ic{background:rgba(0,229,255,.1);border-color:rgba(0,229,255,.3)}.rec.bell .rec-ic svg{stroke:var(--accent)}
  .rec.plain .rec-ic{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.14)}.rec.plain .rec-ic svg{stroke:var(--muted)}
  .rec-main{flex:1;min-width:0}
  .rec-main b{display:block;font-size:13.5px;font-weight:600;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rec time{font-family:var(--mono);font-size:11.5px;color:var(--muted);letter-spacing:.02em}
  .rec.new{animation:rowIn .5s cubic-bezier(.2,.9,.3,1)}
  @keyframes rowIn{from{opacity:0;transform:translateY(-8px);background:rgba(0,230,118,.16)}to{opacity:1;transform:none}}
  @keyframes slideDown{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.lockwrap::after,.lock{animation:none!important}}

  /* ================= 浅色主题 ================= */
  .card.light{
    --bg-deep:#f0f4f8;--surface:#ffffff;--line:rgba(0,100,180,.14);
    --accent:#0097a7;--accent-2:#3f51b5;--info:#1565c0;--success:#2e7d32;
    --danger:#c62828;--warn:#e65100;--text:#1a2332;--muted:#5a6a7a;
    background:linear-gradient(rgba(0,60,120,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(0,60,120,.035) 1px,transparent 1px),linear-gradient(160deg,#ffffff 0%,#f4f7fa 55%,#eef2f6 100%);
    border-color:rgba(0,80,160,.12);
    box-shadow:0 24px 60px rgba(0,40,80,.12),inset 0 1px 0 rgba(255,255,255,.8);
  }
  .card.light .lockwrap::before{background:radial-gradient(circle at 50% 45%,rgba(0,151,167,.08),rgba(240,244,248,.6) 70%)}
  .card.light .lock .body{fill:rgba(255,255,255,.95)}
  .card.light .batt .t{text-shadow:0 1px 2px rgba(255,255,255,.8)}
  .card.light .status{background:rgba(255,255,255,.75);border-color:rgba(0,80,160,.1)}
  .card.light .tile{background:rgba(255,255,255,.75);border-color:rgba(0,80,160,.1)}
  .card.light .tile:hover{border-color:rgba(0,151,167,.4);background:rgba(0,151,167,.05)}
  .card.light .filter-menu{background:rgba(255,255,255,.98);border-color:rgba(0,151,167,.25);box-shadow:0 10px 30px rgba(0,40,80,.15)}
  .card.light .date-btn{background:rgba(255,255,255,.85);border-color:rgba(0,151,167,.25)}
  .card.light .calendar-pop{background:rgba(255,255,255,.98);border-color:rgba(0,151,167,.25);box-shadow:0 10px 30px rgba(0,40,80,.15)}
  .card.light .cal-day.selected{color:#ffffff}
  .card.light .rec:hover{background:rgba(0,100,180,.045)}
  .card.light .rec+.rec{border-top-color:rgba(0,80,160,.08)}
  .card.light .rec-ic{background:rgba(46,125,50,.1);border-color:rgba(46,125,50,.3)}
  .card.light .rec.bad .rec-ic{background:rgba(198,40,40,.1);border-color:rgba(198,40,40,.35)}
  .card.light .rec.info .rec-ic{background:rgba(21,101,192,.1);border-color:rgba(21,101,192,.3)}
  .card.light .rec.bell .rec-ic{background:rgba(0,151,167,.1);border-color:rgba(0,151,167,.3)}
  .card.light .rec.plain .rec-ic{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.1)}
  .card.light .rec-empty{border-color:rgba(0,0,0,.14);color:#6b7783}
  `;
  }

  /* ================= 事件绑定 ================= */
  _bindEvents(){
    const e = this._el;

    // 筛选菜单
    e.filterBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      const willOpen = !e.filterMenu.classList.contains('open');
      e.filterMenu.classList.toggle('open', willOpen);
      if(willOpen) this._fitFilterMenu();
    });
    this.shadowRoot.addEventListener('click', () => e.filterMenu.classList.remove('open'));
    e.filterMenu.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        this._currentFilter = b.dataset.filter;
        e.filterMenu.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        e.datePicker.classList.toggle('open', this._currentFilter === 'date');
        e.filterBtn.textContent = (this._currentFilter === 'all' ? '筛选' : b.textContent) + ' ▾';
        if(this._currentFilter !== 'date') this._closeCal();
        this._applyFilter();
        e.filterMenu.classList.remove('open');
      });
    });

    // 日历
    e.startDateBtn.addEventListener('click', () => this._openCal('start'));
    e.endDateBtn.addEventListener('click', () => this._openCal('end'));
    e.calPrev.addEventListener('click', () => {
      this._calMonth--; if(this._calMonth < 0){ this._calMonth = 11; this._calYear--; }
      this._renderCal();
    });
    e.calNext.addEventListener('click', () => {
      this._calMonth++; if(this._calMonth > 11){ this._calMonth = 0; this._calYear++; }
      this._renderCal();
    });
    this.shadowRoot.addEventListener('click', ev => {
      if(!ev.target.closest('.rec-date-picker')) this._closeCal();
    });

    // 电量 more-info
    if(this._cfg.battery){
      if(this._cfg.battery.primary) e.battBig.addEventListener('click', () => this._moreInfo(this._cfg.battery.primary));
      if(this._cfg.battery.secondary) e.battSmall.addEventListener('click', () => this._moreInfo(this._cfg.battery.secondary));
    }

    // 卡片空白 more-info
    // ⚠ 这里监听在 host 上：事件冒泡出 shadow DOM 后 ev.target 会被「重定向」成
    // 卡片元素本身，closest('.filter') 等永远返回 null，守卫形同虚设 ——
    // 于是点击筛选菜单项/日历/电池都会先弹出实体详情。
    // composedPath()[0] 才是冒泡前的真实目标（仍在 shadow 内）。
    this.addEventListener('click', ev => {
      const path = ev.composedPath ? ev.composedPath() : null;
      const src = (path && path[0]) || ev.target;
      if(!src || typeof src.closest !== 'function') return;
      if(src.closest('.batt') || src.closest('.filter') || src.closest('.rec-date-picker')) return;
      this._moreInfo(this._cfg.log);
    });
  }

  _moreInfo(entityId){
    if(!entityId) return;
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail:{ entityId }, bubbles:true, composed:true }));
  }

  /* ================= hass diff =================
   * 注意：HA 的 hass 对象上实体不在顶层，必须走 hass.states[entity_id]。 */
  _diffHass(hass){
    const c = this._cfg;
    const st = hass.states || {};
    const prev = this._prev || {};
    const next = {};

    /* 取实体；只在状态/时间真的变化时返回 true，同时记录快照 */
    const chg = (id, useTime) => {
      if(!id){ return false; }
      const s = st[id];
      if(!s){ next[id] = null; return false; }
      const key = useTime ? s.last_changed : s.state;
      const old = prev[id];
      next[id] = { key };
      return !old || old.key !== key;
    };

    // 标题（未配置时读日志实体 friendly_name）
    if(!c.title && c.log && st[c.log]){
      const name = st[c.log].attributes && st[c.log].attributes.friendly_name;
      if(name && name !== this._el.title.textContent) this._el.title.textContent = name;
    }

    // 锁状态
    if(c.locked){
      if(chg(c.locked)){
        const s = st[c.locked];
        if(s) this._applyLockState(s.state === 'on');
      }
      if(!st[c.locked]) this._setBadge('—', 'locked');   // 实体缺失/未知 → 显示占位
    }

    // 布防
    if(c.arm){
      if(chg(c.arm)){
        const s = st[c.arm];
        if(s) this._setTile(this._el.armTile, this._el.armVal,
                            s.state === 'on', '布防中', '未布防');
      }
      if(!st[c.arm]) this._setTileUnset(this._el.armTile, this._el.armVal);
    } else {
      this._setTileUnset(this._el.armTile, this._el.armVal);
    }

    // 童锁
    if(c.child){
      if(chg(c.child)){
        const s = st[c.child];
        if(s) this._setTile(this._el.childTile, this._el.childVal,
                            s.state === 'on', '已开启', '未开启');
      }
      if(!st[c.child]) this._setTileUnset(this._el.childTile, this._el.childVal);
    } else {
      this._setTileUnset(this._el.childTile, this._el.childVal);
    }

    // 电量：未配置或实体缺失的那条隐藏（DESIGN §4①）
    if(c.battery && (c.battery.primary || c.battery.secondary)){
      const pb = c.battery.primary   && st[c.battery.primary];
      const sb = c.battery.secondary && st[c.battery.secondary];
      const showBig   = !!(c.battery.primary   && pb);
      const showSmall = !!(c.battery.secondary && sb);
      this._el.battGroup.style.display = (showBig || showSmall) ? 'flex' : 'none';
      this._el.battBig.style.display   = showBig ? '' : 'none';
      this._el.battSmall.style.display = showSmall ? '' : 'none';
      if(showBig && chg(c.battery.primary))          this._setBatt(this._el.battBig, pb.state);
      if(showSmall && chg(c.battery.secondary))      this._setBatt(this._el.battSmall, sb.state);
    } else {
      this._el.battGroup.style.display = 'none';
    }

    // 日志传感器：按 last_changed 判定，避免同状态刷新重复插入
    if(c.log){
      if(chg(c.log, true) && st[c.log]) this._onLogChange(st[c.log]);
    }

    this._prev = next;
  }

  _setBadge(text, cls){
    this._el.badge.className = 'badge ' + cls;
    this._el.badge.textContent = text;
  }

  _setTile(tile, val, on, onText, offText){
    val.textContent = on ? onText : offText;
    val.className = 't-val ' + (on ? 'ok' : 'mut');
    tile.classList.toggle('on', on);
  }

  _setTileUnset(tile, val){
    val.textContent = '—';
    val.className = 't-val mut unset';
    tile.classList.remove('on');
  }

  _applyLockState(unlocked){
    this._el.lockWrap.dataset.state = unlocked ? 'unlocked' : 'locked';
    if(unlocked){
      this._el.badge.className = 'badge unlocked';
      this._el.badge.textContent = '已开锁';
    } else {
      this._el.badge.className = 'badge locked';
      this._el.badge.textContent = '已上锁';
    }
  }

  _setBatt(el, state){
    const pct = parseInt(state, 10);
    if(isNaN(pct)) return;
    el.querySelector('.t').textContent = pct + '%';
    el.querySelector('.bar').style.height = Math.max(4, Math.round(3 + pct * 0.15)) + 'px';
    const low = this._cfg.low;
    el.classList.toggle('warn', pct >= low && pct < 50);
    el.classList.toggle('low', pct < low);
  }

  /* ================= 日志处理 ================= */
  _onLogChange(entity){
    const parsed = this._parseLog(entity);
    if(!parsed) return;

    const cat = this._classify(parsed);
    const isExternal = parsed.attrs['操作位置'] === '外部开锁';
    const isUnlock = cat === 'unlock';
    const key = parsed.ts.getTime() + '|' + parsed.content;

    // 去重：历史已回填过 / 同一条被重复推送时，不再插入，
    // 但状态行/统计仍按本条事件更新。
    const known = this._records.some(r => r.parsed.ts.getTime() + '|' + r.parsed.content === key)
               || this._live.some(r => r.parsed.ts.getTime() + '|' + r.parsed.content === key);

    if(!known){
      // 记入「待历史回填」队列：recorder 写库有延迟，2s 后的历史接口
      // 往往还没有这一条，整表重绘会把刚插入的最新记录抹掉。
      // 这里先记账，_processHistory 合并时会把它补回来。
      this._live.push({ parsed, cat, isExternal });
      if(this._live.length > 20) this._live.splice(0, this._live.length - 20);

      // 插入记录
      this._insertRecord(parsed, cat);
    }

    // 状态行：仅开锁事件更新
    if(isUnlock){
      // 常驻值只认「外部开锁」（DESIGN §4③）。内部开锁（指纹/密码在家开锁）
      // 仍走 3s 瞬时显示 + 今日计数，但不得覆盖常驻值 —— 否则在没有外部开锁
      // 的记录窗口内，内部开锁会污染状态行。
      if(isExternal) this._lastUnlock = { text: parsed.content, when: this._fmtWhen(parsed.ts), ts: parsed.ts };
      this._showStatus('ok', parsed.content, this._fmtWhen(parsed.ts));
      if(this._isCounted({ cat, isExternal })) this._bumpToday();   // 受 include_internal 开关控制
    } else if(cat === 'fail'){
      this._shakeLock();
      this._showStatus('err', parsed.content, this._fmtWhen(parsed.ts));
    } else if(cat === 'bell'){
      this._ringHead();
      this._showStatus('busy', parsed.content, this._fmtWhen(parsed.ts));
    } else if(cat === 'lock'){
      this._showStatus('info', parsed.content, this._fmtWhen(parsed.ts));
    } else {
      this._showStatus('info', parsed.content, this._fmtWhen(parsed.ts));
    }

    // 使历史缓存失效；延迟 2s 再拉取，把连续推送合并成一次请求
    // （卡片 UI 已在上面同步插入本条记录，无需等网络）
    this._histCache = null;
    clearTimeout(this._histTimer);
    this._histTimer = setTimeout(() => this._fetchHistory(), 2000);
  }

  _parseLog(entity){
    const a = entity.attributes || {};
    let content = a['日志内容'] || '';
    let ts = a['时间'] || '';

    // 空行过滤
    if(!content) return null;

    // 时间解析
    let date = null;
    if(ts){
      date = new Date(ts.replace(' ', 'T'));
      if(isNaN(date.getTime())) date = null;
    }
    if(!date){
      // 回退：state 正则
      const m = entity.state.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}):(.*)$/);
      if(m){
        content = m[2];
        date = new Date(m[1].replace(' ', 'T'));
      }
    }
    if(!date) date = new Date(entity.last_changed);

    return { content, ts: date, attrs: a, raw: entity.state };
  }

  _classify(parsed){
    const a = parsed.attrs;
    const action = (a['锁动作'] || '').trim();
    const content = (parsed.content || '').trim();

    // 1 门铃（DESIGN §2.1）
    if(content === '门铃响了' || action === '门铃') return 'bell';

    // 2 锁动作非空 = 开关锁事件，再按动作细分开/关
    if(action){
      if(/开锁|开门/.test(action)) return 'unlock';
      if(/关锁|上锁|关门/.test(action)) return 'lock';
      return 'other';
    }

    // 3 锁动作为空且非门铃 = 异常事件（DESIGN §2.1）
    //   用 failWords 判定失败类，其余归「其它」
    const words = this._cfg.failWords || [];
    if(words.some(w => content.includes(w))) return 'fail';
    return 'other';
  }

  _insertRecord(parsed, cat){
    const row = document.createElement('div');
    row.className = 'rec new ' + (CAT_CLASS[cat] || 'plain');
    row.dataset.cat = cat;
    row.dataset.date = this._dateLabel(parsed.ts);
    row.dataset.iso = isoLocal(parsed.ts);

    const ico = cat === 'unlock' ? 'pw' : cat === 'lock' ? 'lock' : cat === 'fail' ? 'x' : cat === 'bell' ? 'bell' : 'dot';
    row.innerHTML = `
      <span class="rec-ic"><svg viewBox="0 0 24 24">${ICONS[ico]}</svg></span>
      <div class="rec-main"><b></b></div>
      <time>${this._fmtTime(parsed.ts)}</time>`;
    row.querySelector('b').textContent = parsed.content;

    this._el.recList.prepend(row);
    this._applyFilter();
    this._el.recList.scrollTop = 0;
  }

  _showStatus(cls, text, ts){
    clearTimeout(this._resetTimer);
    this._el.status.className = 'status ' + cls;
    this._el.statusText.textContent = text;
    this._el.statusTs.textContent = ts;
    this._resetTimer = setTimeout(() => this._showDefaultStatus(), 3000);
  }

  _showDefaultStatus(){
    this._el.status.className = 'status';
    if(this._lastUnlock){
      this._el.statusText.textContent = this._lastUnlock.text;
      this._el.statusTs.textContent = this._lastUnlock.when;
    } else {
      this._el.statusText.textContent = '尚无外部开锁记录';
      this._el.statusTs.textContent = '';
    }
  }

  _shakeLock(){
    const w = this._el.lockWrap;
    w.classList.remove('shake'); void w.offsetWidth;
    w.classList.add('shake');
    setTimeout(() => w.classList.remove('shake'), 1300);
  }

  _ringHead(){
    const h = this._el.headIcon;
    h.classList.remove('ring'); void h.offsetWidth;
    h.classList.add('ring');
    setTimeout(() => h.classList.remove('ring'), 1200);
  }

  /* 「内部开锁计入统计」开关（records.include_internal，默认 false）：
     false → 今日开锁只统计明确标注「外部开锁」的开锁事件；
     true  → 内外部一并统计。
     DESIGN 配置项原文：是否把「内部开锁/室内推拉」计入开锁统计。 */
  _isCounted(r){
    if(!r || r.cat !== 'unlock') return false;
    if(this._cfg.records.include_internal) return true;
    return !!r.isExternal;
  }

  _bumpToday(){
    this._todayCount++;
    this._el.todayVal.innerHTML = this._todayCount + '<small>次</small>';
    this._el.todayVal.classList.remove('bump'); void this._el.todayVal.offsetWidth;
    this._el.todayVal.classList.add('bump');
  }

  /* ================= History ================= */
  async _fetchHistory(){
    if(!this._hass || !this._cfg.log) return;
    if(this._histInflight) return;
    if(this._histCache && Date.now() - this._histCache.ts < this._cfg.records.refresh * 1000) return;

    this._histInflight = true;
    try {
      const now = new Date();
      const start = new Date(now.getTime() - this._cfg.records.days * 86400000);
      const startISO = start.toISOString();
      const endISO = now.toISOString();

      const data = await this._hass.callApi('GET',
        `history/period/${startISO}?filter_entity_id=${this._cfg.log}&end_time=${endISO}`);

      if(data && Array.isArray(data[0])){
        this._histCache = { ts: Date.now(), data: data[0] };
        this._processHistory(data[0]);
      }
    } catch(err) {
      // 静默失败，降级（DESIGN §11）
      this._histError = err;
    } finally {
      this._histInflight = false;
    }
  }

  /* 历史接口返回的行 + 尚未入库的实时记录，合并成最终列表。
   * recorder 写库有延迟，历史里常常还没有最新一条，必须把实时记录补回来。 */
  _processHistory(rows){
    const keyOf = r => r.parsed.ts.getTime() + '|' + r.parsed.content;
    const records = [];
    const histKeys = new Set();

    for(const row of rows){
      const parsed = this._parseLog(row);
      if(!parsed) continue;
      const cat = this._classify(parsed);
      const isExternal = parsed.attrs['操作位置'] === '外部开锁';
      const k = parsed.ts.getTime() + '|' + parsed.content;
      if(histKeys.has(k)) continue;
      histKeys.add(k);
      records.push({ parsed, cat, isExternal });
    }

    // 已被历史覆盖的实时记录可以清掉；仍缺失的补进列表（保住最新一条）
    this._live = this._live.filter(r => !histKeys.has(keyOf(r)));
    for(const r of this._live) records.push(r);

    // 排序 + 截断。
    // parsed.ts 是秒级精度，同一秒内的多条记录 ts 相等；Array#sort 虽然稳定，
    // 但输入顺序是「时间升序」，直接按 ts 降序会把同秒内的记录反过来（新→旧变成旧→新）。
    // 这里给每条记录记一个输入序号，ts 相同者按序号降序 —— 即保证同秒内新者在前。
    records.forEach((r, i) => { r._seq = i; });
    records.sort((a, b) => (b.parsed.ts - a.parsed.ts) || (b._seq - a._seq));
    records.forEach(r => { delete r._seq; });

    // 统计口径与截断前一致：先算，再截
    let lastUnlock = null;
    let todayCount = 0;
    const today = isoLocal(new Date());
    for(const r of records){
      if(r.cat === 'unlock' && r.isExternal && (!lastUnlock || r.parsed.ts > lastUnlock.ts)){
        lastUnlock = { text: r.parsed.content, when: this._fmtWhen(r.parsed.ts), ts: r.parsed.ts };
      }
      if(this._isCounted(r) && isoLocal(r.parsed.ts) === today) todayCount++;
    }

    this._records = records.slice(0, this._cfg.records.limit);

    // 更新状态行
    if(lastUnlock) this._lastUnlock = lastUnlock;
    this._todayCount = todayCount;
    this._el.todayVal.innerHTML = todayCount + '<small>次</small>';
    this._showDefaultStatus();

    // 渲染记录列表
    this._renderRecords();
  }

  _renderRecords(){
    const list = this._el.recList;
    list.innerHTML = '';

    // 按日期分组
    const groups = {};
    for(const r of this._records){
      const label = this._dateLabel(r.parsed.ts);
      if(!groups[label]) groups[label] = [];
      groups[label].push(r);
    }

    for(const [label, items] of Object.entries(groups)){
      const g = document.createElement('div');
      g.className = 'rec-group';
      g.textContent = label;
      list.appendChild(g);

      for(const r of items){
        const row = document.createElement('div');
        row.className = 'rec ' + (CAT_CLASS[r.cat] || 'plain');
        row.dataset.cat = r.cat;
        row.dataset.date = label;
        row.dataset.iso = isoLocal(r.parsed.ts);

        const ico = r.cat === 'unlock' ? 'pw' : r.cat === 'lock' ? 'lock' : r.cat === 'fail' ? 'x' : r.cat === 'bell' ? 'bell' : 'dot';
        row.innerHTML = `
          <span class="rec-ic"><svg viewBox="0 0 24 24">${ICONS[ico]}</svg></span>
          <div class="rec-main"><b></b></div>
          <time>${this._fmtTime(r.parsed.ts)}</time>`;
        row.querySelector('b').textContent = r.parsed.content;
        list.appendChild(row);
      }
    }

    this._applyFilter();
  }

  /* ================= 筛选 ================= */
  _applyFilter(){
    const visibleDates = {};
    let visible = 0;
    this._el.recList.querySelectorAll('.rec').forEach(row => {
      const cat = row.dataset.cat;
      const date = row.dataset.date;
      let show = false;

      if(this._currentFilter === 'all') show = true;
      else if(this._currentFilter === 'alert') show = (cat === 'fail' || cat === 'bell');
      else if(this._currentFilter === 'unlock') show = cat === 'unlock';
      else if(this._currentFilter === 'lock') show = cat === 'lock';
      else if(this._currentFilter === 'date'){
        const iso = row.dataset.iso;
        if(!iso) show = false;
        else {
          show = true;
          if(this._startDate && iso < this._startDate) show = false;
          if(this._endDate && iso > this._endDate) show = false;
        }
      }

      row.style.display = show ? '' : 'none';
      if(show){ visibleDates[date] = true; visible++; }
    });

    this._el.recList.querySelectorAll('.rec-group').forEach(g => {
      g.style.display = visibleDates[g.textContent] ? '' : 'none';
    });

    // 空结果占位：撑住卡片高度 + 给出反馈
    if(this._el.recEmpty) this._el.recEmpty.hidden = visible > 0;
  }

  /* 菜单打开后确认整块落在卡片可视区内。
   * .card 是 overflow:hidden，菜单一旦探出卡片下沿就会被裁掉 ——
   * 筛选结果很少/为空时 .rec-list 塌陷、卡片变矮，下半截选项会点不到。
   * 下方放不下就翻到按钮上方；上下都放不下则限高并内部滚动。 */
  _fitFilterMenu(){
    const m = this._el.filterMenu, card = this._el.card, btn = this._el.filterBtn;
    if(!m || !card || !btn) return;

    m.classList.remove('up');
    m.style.maxHeight = '';
    m.style.overflowY = '';
    if(!m.classList.contains('open')) return;

    const PAD = 8, GAP = 6;
    const box = btn.parentElement || btn;          // .filter 是菜单的定位祖先
    const cr = card.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const h  = m.offsetHeight;                     // 布局高度，不受 slideDown 的 transform 影响
    if(!h) return;

    if(br.bottom + GAP + h > cr.bottom - PAD){      // 默认向下展开时会越出下沿
      m.classList.add('up');
      if(br.top - GAP - h < cr.top + PAD){          // 向上也不够 → 限高 + 内部滚动
        const avail = (cr.bottom - PAD) - (cr.top + PAD);
        if(avail > 60){ m.style.maxHeight = avail + 'px'; m.style.overflowY = 'auto'; }
      }
    }
  }

  /* ================= 日历 ================= */
  _openCal(target){
    this._calTarget = target;
    if(!this._calYear){
      const now = new Date();
      this._calYear = now.getFullYear();
      this._calMonth = now.getMonth();
    }
    this._renderCal();
    this._el.calendarPop.classList.add('open');
  }

  _closeCal(){
    this._el.calendarPop.classList.remove('open');
  }

  _renderCal(){
    const e = this._el;
    e.calTitle.textContent = this._calYear + '年' + (this._calMonth + 1) + '月';
    e.calGrid.querySelectorAll('.cal-day').forEach(d => d.remove());

    const firstDow = new Date(this._calYear, this._calMonth, 1).getDay();
    const daysInMonth = new Date(this._calYear, this._calMonth + 1, 0).getDate();

    for(let i = 0; i < firstDow; i++){
      const s = document.createElement('span');
      s.className = 'cal-day empty';
      e.calGrid.appendChild(s);
    }

    for(let d = 1; d <= daysInMonth; d++){
      const btn = document.createElement('span');
      btn.className = 'cal-day';
      btn.textContent = d;
      const iso = this._calYear + '-' + String(this._calMonth + 1).padStart(2,'0') + '-' + String(d).padStart(2,'0');

      if(iso === this._startDate || iso === this._endDate) btn.classList.add('selected');
      else if(this._startDate && this._endDate && iso > this._startDate && iso < this._endDate) btn.classList.add('in-range');

      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        if(this._calTarget === 'start'){
          this._startDate = iso;
          e.startDateText.textContent = this._fmtDateShort(iso);
          e.startDateBtn.classList.add('filled');
        } else {
          this._endDate = iso;
          e.endDateText.textContent = this._fmtDateShort(iso);
          e.endDateBtn.classList.add('filled');
        }
        // 起止颠倒自动交换
        if(this._startDate && this._endDate && this._startDate > this._endDate){
          const t = this._startDate; this._startDate = this._endDate; this._endDate = t;
          e.startDateText.textContent = this._fmtDateShort(this._startDate);
          e.endDateText.textContent = this._fmtDateShort(this._endDate);
        }
        this._applyFilter();
        this._renderCal();
        this._closeCal();
      });

      e.calGrid.appendChild(btn);
    }
  }

  /* ================= 时间格式化 ================= */
  _fmtTime(ts){
    const d = new Date(ts);
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }

  _fmtWhen(ts){
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(today); yest.setDate(today.getDate() - 1);
    const hm = this._fmtTime(ts);
    if(isoLocal(d) === isoLocal(today)) return '今天 ' + hm;
    if(isoLocal(d) === isoLocal(yest)) return '昨天 ' + hm;
    return isoLocal(d) + ' ' + hm;
  }

  _dateLabel(ts){
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(today); yest.setDate(today.getDate() - 1);
    if(isoLocal(d) === isoLocal(today)) return '今天';
    if(isoLocal(d) === isoLocal(yest)) return '昨天';
    return isoLocal(d).slice(5);
  }

  _fmtDateShort(s){
    const today = new Date();
    const yest = new Date(today); yest.setDate(today.getDate() - 1);
    if(s === isoLocal(today)) return '今天';
    if(s === isoLocal(yest)) return '昨天';
    return s.slice(5);
  }
}

/* ============================================================
 *  UI 配置编辑器（Lovelace 可视化配置面板）
 *  自绘 Shadow DOM 面板 —— 不依赖 ha-form，控件与卡片同源
 *  入口：卡片类里的 static getConfigElement()
 * ============================================================ */

/* ---------- 嵌套配置读写助手（路径形如 battery.low） ---------- */
function _edGet(obj, path){
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function _edHas(obj, path){
  const ks = path.split('.'); const last = ks.pop();
  const t = ks.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  return t != null && typeof t === 'object' && last in t;
}
function _edDel(obj, path){
  const ks = path.split('.'); const last = ks.pop();
  const t = ks.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  if(t != null && typeof t === 'object') delete t[last];
}
function _edSet(obj, path, val){
  const ks = path.split('.'); const last = ks.pop();
  const t = ks.reduce((o, k) => { if(o[k] == null || typeof o[k] !== 'object') o[k] = {}; return o[k]; }, obj);
  t[last] = val;
}
/* 空容器回收：battery / records 被清空时整块移除，保持 YAML 干净 */
function _edPrune(cfg, key){
  if(cfg[key] && typeof cfg[key] === 'object' && Object.keys(cfg[key]).length === 0) delete cfg[key];
}
function _edSame(a, b){ return a === b; }

/* ---------- 配置 → YAML（实时预览用，字符串含特殊字符时加引号） ---------- */
function _edToYaml(val, indent){
  indent = indent || '';
  if(val === null || val === undefined) return 'null';
  if(typeof val === 'boolean' || typeof val === 'number') return String(val);
  if(typeof val === 'string'){
    if(val === '') return '""';
    /* 含 YAML 保留字符或以特殊符号开头时才加双引号 */
    const unsafe = /^[-?:,[\]{}#&*!|>'"%@`]/.test(val) ||
                   /[:#]\s/.test(val) || /^\s|\s$/.test(val);
    return unsafe ? JSON.stringify(val) : val;
  }
  if(Array.isArray(val)){
    if(!val.length) return '[]';
    return val.map(v => {
      const s = (typeof v === 'object' && v !== null) ? _edToYaml(v, indent + '  ') : _edToYaml(v);
      return indent + '- ' + s.replace(new RegExp('^' + indent.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')), '');
    }).join('\n');
  }
  const keys = Object.keys(val).filter(k => val[k] !== undefined);
  if(!keys.length) return '{}';
  return keys.map(k => {
    const v = val[k];
    const isBlock = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length;
    if(isBlock) return indent + k + ':\n' + _edToYaml(v, indent + '  ');
    if(Array.isArray(v) && v.length) return indent + k + ':\n' + _edToYaml(v, indent + '  ');
    return indent + k + ': ' + _edToYaml(v);
  }).join('\n');
}

/* ---------- 字段定义 ---------- */
const ED_SECTIONS = [
  { id:'source', icon:'mdi:file-document-edit-outline', title:'数据源', desc:'卡片唯一的取数来源',
    fields:[
      { path:'log', type:'entity', domain:'sensor', label:'日志实体', required:true,
        help:'核心数据源，state 形如「时间:日志内容」', err:'日志实体为必填，当前修改不会保存' },
      { path:'title', type:'text', label:'卡片标题', placeholder:'鹿客智能锁 V5 Max',
        help:'留空则自动读取日志实体的设备名' }
    ]},

  { id:'state', icon:'mdi:shield-lock-outline', title:'状态实体', desc:'中央锁图标与两块统计格的数据源',
    fields:[
      { path:'locked', type:'entity', domain:'binary_sensor', label:'锁状态',
        help:'on = 已开锁（锁梁弹开），off = 已上锁' },
      { path:'arm', type:'entity', domain:'binary_sensor', label:'布防状态',
        help:'on = 布防中，显示在左侧统计格' },
      { path:'child', type:'entity', domain:'binary_sensor', label:'童锁',
        help:'on = 童锁已开启，显示在右侧统计格' }
    ]},

  { id:'battery', icon:'mdi:battery-charging-high', title:'电量', desc:'右上角双电量条，留空的那条自动隐藏',
    fields:[
      { path:'battery.primary', type:'entity', domain:'sensor', deviceClass:'battery',
        label:'大电池', help:'未配置电池组时无需填写' },
      { path:'battery.secondary', type:'entity', domain:'sensor', deviceClass:'battery',
        label:'小电池', help:'两条电量条按高度对齐排布' },
      { path:'battery.low', type:'number', label:'低电量阈值', min:0, max:100, step:1, unit:'%',
        def:20, help:'低于此值电量条转为红色（默认 20）' }
    ]},

  { id:'records', icon:'mdi:format-list-numbered', title:'记录列表', desc:'「最近日志」区块的取数与显示',
    fields:[
      { path:'show_records', type:'toggle', label:'显示记录列表', def:true,
        help:'关闭后隐藏整个「最近日志」区块' },
      { path:'records.events', type:'segment', label:'日志过滤', def:'all',
        options:[{ value:'all', label:'全部日志' }, { value:'unlock', label:'仅开锁类' }],
        help:'「仅开锁类」会隐藏门铃与异常事件' },
      { path:'records.include_internal', type:'toggle', label:'内部开锁计入统计', def:false,
        help:'把「室内推拉开门」也算进今日开锁次数' },
      { path:'records.days', type:'number', label:'历史天数', min:1, max:30, step:1, def:2,
        help:'从 History API 拉取的天数' },
      { path:'records.limit', type:'number', label:'最多显示条数', min:1, max:50, step:1, def:5,
        help:'列表按日期分组后渲染的行数上限' },
      { path:'records.refresh', type:'number', label:'缓存刷新', min:10, max:3600, step:10, def:60,
        unit:'秒', help:'历史结果缓存时长，日志变化会立即失效' }
    ]},

  { id:'look', icon:'mdi:palette-outline', title:'外观与交互', desc:'主题与点击行为',
    fields:[
      { path:'theme', type:'segment', label:'主题', def:'dark',
        options:[{ value:'dark', label:'深色 · 科技风' }, { value:'light', label:'浅色' }, { value:'auto', label:'自动' }] },
      { path:'tap_action', type:'segment', label:'点击卡片空白处', def:'more-info',
        options:[{ value:'more-info', label:'弹出实体详情' }, { value:'none', label:'无动作' }] }
    ]}
];

/* 扁平字段表：def 与卡片 setConfig 的回退值保持一致 */
const ED_ALL = ED_SECTIONS.reduce((a, s) => a.concat(s.fields), []).map(f => ({
  path: f.path,
  type: f.type,                       /* _syncUI 按 type 分派，必须保留 */
  def: f.def !== undefined ? f.def
     : (f.type === 'toggle' ? false
     : (f.type === 'number' ? (f.min !== undefined ? f.min : 0) : ''))
}));

/* ---------- 编辑器样式（全部跟随 HA 主题变量，深浅色自适应） ---------- */
const ED_CSS = `
:host{ display:block; --ed-gap:14px; --ed-radius:14px;
  --ed-fg: var(--primary-text-color, #1c1c1c);
  --ed-fg2: var(--secondary-text-color, #666);
  --ed-line: var(--divider-color, rgba(0,0,0,.12));
  /* --ha-card-background 在 <html> 上并未定义（实测为空字符串），直接回落到写死的
     #fff 会让编辑器在 HA 深色模式下变成「纯白底 + 浅灰字」。改用 HA 真正会随
     主题模式翻转的 --card-background-color，深浅色自动跟随。 */
  --ed-card: var(--ha-card-background, var(--card-background-color, #fff));
  --ed-accent: var(--primary-color, #03a9f4);
  --ed-err: var(--error-color, #f44336);
}
:host([hidden]){ display:none }

.ed{ display:flex; flex-direction:column; gap:var(--ed-gap);
  font-family: inherit; color:var(--ed-fg); padding-bottom:4px; }

/* ── 分区卡片 ── */
.sec{ background:var(--ed-card); border:1px solid var(--ed-line);
  border-radius:var(--ed-radius); overflow:hidden; }
.sh{ display:flex; align-items:center; gap:12px;
  padding:13px 16px; border-bottom:1px solid var(--ed-line);
  background:linear-gradient(180deg, rgba(0,0,0,.02), transparent); }
.si{ width:30px; height:30px; border-radius:9px; flex:0 0 auto;
  display:grid; place-items:center; color:var(--ed-accent);
  background:color-mix(in srgb, var(--ed-accent) 14%, transparent); }
.si ha-icon{ --mdc-icon-size:17px; }
.stx{ display:flex; flex-direction:column; gap:2px; min-width:0; }
.stx b{ font-size:13.5px; font-weight:650; letter-spacing:.03em; }
.stx i{ font-size:11.5px; font-style:normal; color:var(--ed-fg2); }

.sb{ display:flex; flex-direction:column; padding:4px 16px 8px; }

/* ── 字段行 ── */
.f{ display:flex; flex-direction:column; gap:6px;
  padding:12px 0; border-bottom:1px solid var(--ed-line); }
.f:last-child{ border-bottom:0; }
.fl{ font-size:12.5px; font-weight:600; display:flex; align-items:center; gap:7px; }
.fh{ margin:0; font-size:11.5px; line-height:1.55; color:var(--ed-fg2); }
.fe{ margin:0; font-size:11.5px; font-weight:600; color:var(--ed-err); }
.fe[hidden]{ display:none }
.fc{ display:flex; }

/* 开关行：左文案 + 右开关 */
.f.row{ flex-direction:row; align-items:center; justify-content:space-between; gap:16px; }
.f.row .ft{ display:flex; flex-direction:column; gap:3px; min-width:0; }
.f.row .fc{ flex:0 0 auto; }

/* ── 控件 ── */
ha-entity-picker{ width:100%; --paper-item-body-min-height:36px; }

.tin{ width:100%; height:36px; padding:0 12px; font-size:13.5px;
  color:var(--ed-fg); background:var(--ed-card);
  border:1px solid var(--ed-line); border-radius:9px; outline:none;
  font-family:inherit; transition:border-color .15s, box-shadow .15s; }
.tin::placeholder{ color:var(--ed-fg2); opacity:.7; }
.tin:focus{ border-color:var(--ed-accent);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--ed-accent) 22%, transparent); }

/* 数字步进 */
.step{ display:flex; align-items:center; gap:8px; }
.step button{ width:34px; height:34px; border-radius:9px; flex:0 0 auto;
  border:1px solid var(--ed-line); background:var(--ed-card); color:var(--ed-fg);
  font-size:17px; line-height:1; cursor:pointer; transition:.15s; }
.step button:hover{ border-color:var(--ed-accent); color:var(--ed-accent); }
.step button:active{ transform:scale(.93); }
.step input{ width:74px; height:34px; text-align:center; padding:0 4px;
  font-size:14px; font-weight:650; font-variant-numeric:tabular-nums;
  color:var(--ed-fg); background:var(--ed-card);
  border:1px solid var(--ed-line); border-radius:9px; outline:none;
  -moz-appearance:textfield; }
.step input::-webkit-outer-spin-button,
.step input::-webkit-inner-spin-button{ -webkit-appearance:none; margin:0; }
.step input:focus{ border-color:var(--ed-accent); }
.step .su{ font-size:12px; color:var(--ed-fg2); }

/* 分段选择 */
.seg{ display:flex; gap:4px; padding:4px; width:100%;
  background:color-mix(in srgb, var(--ed-fg) 6%, transparent);
  border:1px solid var(--ed-line); border-radius:11px; }
.seg button{ flex:1; height:31px; border:0; border-radius:8px; cursor:pointer;
  font-size:12.5px; font-weight:600; font-family:inherit;
  color:var(--ed-fg2); background:transparent; transition:.15s; white-space:nowrap; }
.seg button:hover{ color:var(--ed-fg); }
.seg button.on{ color:#fff; background:var(--ed-accent);
  box-shadow:0 1px 3px color-mix(in srgb, var(--ed-accent) 45%, transparent); }

/* ── 必填横幅 ── */
.banner{ display:flex; align-items:center; gap:9px; padding:11px 15px;
  font-size:12.5px; font-weight:600; color:var(--ed-err);
  background:color-mix(in srgb, var(--ed-err) 11%, transparent);
  border:1px solid color-mix(in srgb, var(--ed-err) 35%, transparent);
  border-radius:11px; }
.banner[hidden]{ display:none }
`;

class XiaomiLockCardEditor extends HTMLElement {

  constructor(){
    super();
    this.attachShadow({ mode:'open' });
    this._config = {};
    this._draft  = {};     // 表单草稿：path → 值（始终持有完整默认值）
    this._dirty  = new Set();  // 用户实际改动过的字段路径
    this._ui     = {};     // path → 控件
    this._syncing = false;
    this._render();
  }

  setConfig(config){
    this._config = { ...(config || {}) };
    /* 草稿从 YAML 初始化；缺省字段回落到 def，保证界面永远有完整取值 */
    this._draft = {};
    this._dirty = new Set();   /* 外部（YAML）写入不算用户改动 */
    for(const f of ED_ALL){
      const v = _edGet(this._config, f.path);
      this._draft[f.path] = (v === undefined || v === null) ? f.def : v;
    }
    this._syncUI();
    this._rebuild(false);
  }

  getConfig(){ return this._config; }

  set hass(hass){
    this._hass = hass;
    for(const el of Object.values(this._ui)){
      if(el.tagName === 'HA-ENTITY-PICKER') el.hass = hass;
    }
  }

  /* ---------- 渲染 ---------- */
  _render(){
    this.shadowRoot.innerHTML = `<style>${this._css()}</style><div class="ed" id="root"></div>`;
    const root = this.shadowRoot.getElementById('root');

    this._banner = document.createElement('div');
    this._banner.className = 'banner';
    this._banner.hidden = true;
    root.appendChild(this._banner);

    for(const sec of ED_SECTIONS) root.appendChild(this._section(sec));
  }

  _section(sec){
    const el = document.createElement('section');
    el.className = 'sec';
    el.innerHTML =
      `<header class="sh">
         <span class="si"><ha-icon icon="${sec.icon}"></ha-icon></span>
         <span class="stx"><b></b><i></i></span>
       </header>
       <div class="sb"></div>`;
    el.querySelector('.stx b').textContent = sec.title;
    el.querySelector('.stx i').textContent = sec.desc;
    const body = el.querySelector('.sb');
    for(const f of sec.fields) body.appendChild(this._field(f));
    return el;
  }

  _field(f){
    const wrap = document.createElement('div');
    const isToggle = f.type === 'toggle';
    wrap.className = 'f' + (isToggle ? ' row' : '');

    const lab = document.createElement('label');
    lab.className = 'fl';
    lab.textContent = f.label;
    if(f.required){
      const em = document.createElement('em');
      em.className = 'req'; em.textContent = '必填';
      lab.appendChild(em);
    }

    const ctrl = document.createElement('div');
    ctrl.className = 'fc';

    if(isToggle){
      /* 开关行：左侧文案 + 说明，右侧开关 */
      const txt = document.createElement('div');
      txt.className = 'ft';
      txt.appendChild(lab);
      if(f.help){ const h = document.createElement('p'); h.className = 'fh'; h.textContent = f.help; txt.appendChild(h); }
      wrap.appendChild(txt);
      ctrl.appendChild(this._build(f));
      wrap.appendChild(ctrl);
      this._ui[f.path] = ctrl.firstChild;
      return wrap;
    }

    wrap.appendChild(lab);
    ctrl.appendChild(this._build(f));
    wrap.appendChild(ctrl);

    if(f.help){ const h = document.createElement('p'); h.className = 'fh'; h.textContent = f.help; wrap.appendChild(h); }
    if(f.err){ const e = document.createElement('p'); e.className = 'fe'; e.textContent = f.err; e.hidden = true; wrap.appendChild(e); }

    this._ui[f.path] = ctrl.firstChild;
    return wrap;
  }

  _build(f){
    let el;
    switch(f.type){
      case 'entity': {
        el = document.createElement('ha-entity-picker');
        el.hass = this._hass;
        el.label = '';
        if(f.domain) el.domain = f.domain;
        if(f.deviceClass){
          el.entity_filter = (eid, state) =>
            !state || !state.attributes || state.attributes.device_class === f.deviceClass;
        }
        el.setAttribute('placeholder', '选择实体（可留空）');
        el.addEventListener('value-changed', ev => this._on(f, ev.detail ? ev.detail.value : undefined));
        break;
      }
      case 'text': {
        el = document.createElement('input');
        el.type = 'text';
        el.className = 'tin';
        if(f.placeholder) el.placeholder = f.placeholder;
        el.addEventListener('input', ev => this._on(f, ev.target.value));
        break;
      }
      case 'toggle': {
        el = document.createElement('ha-switch');
        el.addEventListener('change', ev => this._on(f, !!ev.target.checked));
        break;
      }
      case 'number': {
        el = document.createElement('div');
        el.className = 'step';
        el.innerHTML = `<button type="button" class="mn" aria-label="减少">−</button>
                        <input type="number" class="nv" min="${f.min}" max="${f.max}" step="${f.step || 1}">
                        <button type="button" class="pl" aria-label="增加">+</button>
                        <span class="su"></span>`;
        el.querySelector('.su').textContent = f.unit || '';
        const inp = el.querySelector('.nv');
        const clamp = v => Math.min(f.max, Math.max(f.min, v));
        const bump = d => { const v = clamp(Number(inp.value || f.def) + d); inp.value = v; this._on(f, v); };
        el.querySelector('.mn').addEventListener('click', () => bump(-(f.step || 1)));
        el.querySelector('.pl').addEventListener('click', () => bump(f.step || 1));
        inp.addEventListener('change', () => { const v = clamp(Number(inp.value)); const ok = !isNaN(v); inp.value = ok ? v : f.def; this._on(f, ok ? v : f.def); });
        break;
      }
      case 'segment': {
        el = document.createElement('div');
        el.className = 'seg';
        for(const o of f.options){
          const b = document.createElement('button');
          b.type = 'button'; b.dataset.v = o.value; b.textContent = o.label;
          b.addEventListener('click', () => this._on(f, o.value));
          el.appendChild(b);
        }
        break;
      }
      default: {
        el = document.createElement('input'); el.type = 'text'; el.className = 'tin';
        el.addEventListener('input', ev => this._on(f, ev.target.value));
      }
    }
    return el;
  }

  /* ---------- 取值 / 写回 ---------- */
  _syncUI(){
    this._syncing = true;
    for(const f of ED_ALL){
      const el = this._ui[f.path];
      if(!el) continue;
      const v = this._draft[f.path];
      if(f.type === 'entity')      el.value = v || undefined;
      else if(f.type === 'text'){ if(el.value !== (v || '')) el.value = v || ''; }
      else if(f.type === 'toggle') el.checked = !!v;
      else if(f.type === 'number'){ const i = el.querySelector('.nv'); if(i) i.value = v; }
      else if(f.type === 'segment'){
        el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
      }
    }
    this._validate();
    this._syncing = false;
  }

  _on(f, value){
    if(this._syncing) return;
    this._draft[f.path] = value;
    this._dirty.add(f.path);          /* 记录用户改动，_rebuild 只动这些 */
    if(f.type === 'segment'){
      const el = this._ui[f.path];
      if(el) el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(value)));
    }
    this._rebuild(true);
  }

  /* 草稿 → 配置。规则：只改用户碰过的字段（_dirty），
     等于默认值的键直接删除 —— 未改动的 YAML 原样保留，保证 UI ⇄ YAML 一致 */
  _rebuild(emit){
    const cfg = { ...this._config };
    cfg.type = 'custom:xiaomi-lock-card';

    for(const f of ED_ALL){
      if(!this._dirty.has(f.path)) continue;      /* 没碰过 → 保持原样 */
      const v = this._draft[f.path];
      if(v === '' || v === undefined || v === null || _edSame(v, f.def)) _edDel(cfg, f.path);
      else _edSet(cfg, f.path, v);
    }

    if(this._dirty.size){
      const hit = p => [...this._dirty].some(x => x.indexOf(p + '.') === 0);
      if(hit('battery')) _edPrune(cfg, 'battery');
      if(hit('records')) _edPrune(cfg, 'records');
    }

    this._validate(cfg);
    if(!cfg.log) return;   /* 必填缺失：不写入、不覆盖已保存配置（顶部横幅已提示） */
    this._config = cfg;
    if(emit) this._emitConfig();
  }

  _validate(cfg){
    const c = cfg || this._config;
    const bad = !c.log;
    if(this._banner){
      this._banner.hidden = !bad;
      if(bad) this._banner.textContent = '⚠ 请先选择「日志实体」—— 这是必填项，改动暂未保存。';
    }
    const errEl = this.shadowRoot.querySelector('.fe');
    if(errEl) errEl.hidden = !bad;
  }

  _emitConfig(){
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true
    }));
  }

  _css(){ return ED_CSS; }
}

/* ================= 注册 ================= */
if(!window.customCards) window.customCards = [];
window.customCards.push({
  type: 'custom:xiaomi-lock-card',
  name: '指纹锁卡片',
  description: '鹿客智能锁只读监控卡片（纯事件驱动）',
  preview: false
});

customElements.define('xiaomi-lock-card', XiaomiLockCard);
customElements.define('xiaomi-lock-card-editor', XiaomiLockCardEditor);
