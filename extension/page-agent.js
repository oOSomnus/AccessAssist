// Isolated-world agent for one document. It exposes page structure and
// performs DOM edits; trusted mouse input is dispatched by the worker over CDP.
(() => {
  if (globalThis.__accessAssistAgent?.version === 1) return;

  const docToken = crypto.randomUUID();
  const nodeIds = new WeakMap();
  const nodes = new Map();
  const snapshots = new Map();
  let nextNodeId = 1;

  const TEXT_BLOCKS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'CAPTION', 'FIGCAPTION', 'DT', 'DD', 'ADDRESS', 'LEGEND', 'LABEL', 'OUTPUT']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'HEAD']);
  const TEXTUAL = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time']);
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="gridcell"],[role="grid"],[role="row"],[role="columnheader"],[role="rowheader"],[role="slider"],[role="spinbutton"],[role="tree"],[role="treegrid"],[role="treeitem"],[contenteditable=""],[contenteditable="true"],[onclick],[onmousedown],[onmouseup],[onmouseover],[onmousemove],[onpointerdown],[onpointerup],[onpointermove],[onpointerover],[ondragstart],[ondrag],[draggable="true"]';
  const IMAGES = 'img,canvas,svg';
  const CURSORS = new Set(['pointer', 'move', 'grab', 'grabbing']);
  const MAX_NEAR_CHARS = 80;
  let visualNodeId = null;

  function clean(text) {
    return String(text ?? '').replace(/[\u200b-\u200d\ufeff]/gu, '').replace(/\s+/gu, ' ').trim();
  }

  function idFor(element) {
    let id = nodeIds.get(element);
    if (!id) {
      id = nextNodeId++;
      nodeIds.set(element, id);
      nodes.set(id, element);
    } else if (!nodes.has(id)) {
      // Observation retention may have dropped this map entry; the element is
      // still in the page, so restore the identity the WeakMap still holds.
      nodes.set(id, element);
    }
    return id;
  }

  // ARIA hiding and inert apply through flattened ancestors, which CSS
  // checkVisibility cannot see across a shadow boundary.
  function composedHidden(element) {
    let node = element;
    let guard = 0;
    while (node && guard < 10_000) {
      guard += 1;
      if (node.getAttribute?.('aria-hidden') === 'true' || node.hasAttribute?.('inert')) return true;
      node = node.parentElement ?? node.getRootNode?.()?.host ?? null;
    }
    return false;
  }

  function visible(element) {
    if (!element.isConnected) return false;
    if (composedHidden(element)) return false;
    try {
      return typeof element.checkVisibility === 'function'
        ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : element.getClientRects().length > 0;
    } catch {
      return element.getClientRects().length > 0;
    }
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function inViewport(rect) {
    return rect.width > 1 && rect.height > 1
      && rect.y + rect.height > 0 && rect.x + rect.width > 0
      && rect.y < window.innerHeight && rect.x < window.innerWidth;
  }

  function roleOf(element) {
    const explicit = clean(element.getAttribute('role'));
    if (explicit) return explicit.split(/\s+/u)[0];
    const tag = element.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'IMG') return 'img';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SUMMARY') return 'button';
    if (/^H[1-6]$/u.test(tag)) return 'heading';
    if (tag === 'LI') return 'listitem';
    if (tag === 'P') return 'paragraph';
    if (tag === 'INPUT') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      return 'textbox';
    }
    return tag.toLowerCase();
  }

  function nameOf(element) {
    const labelledBy = clean(element.getAttribute('aria-labelledby'));
    if (labelledBy) {
      const text = labelledBy.split(/\s+/u)
        .map((id) => document.getElementById(id)?.innerText ?? '')
        .join(' ');
      if (clean(text)) return clean(text);
    }
    const aria = clean(element.getAttribute('aria-label'));
    if (aria) return aria;
    if (element.tagName === 'IMG') return clean(element.getAttribute('alt'));
    if (element.labels?.length) {
      const text = clean([...element.labels].map((label) => label.innerText).join(' '));
      if (text) return text;
    }
    if (element.isContentEditable) {
      const text = clean(element.innerText);
      if (text) return text.slice(0, 200);
    }
    const text = clean(element.innerText);
    if (text) return text.slice(0, 200);
    return clean(element.getAttribute('placeholder'))
      || clean(element.getAttribute('title'))
      || clean(element.getAttribute('name'));
  }

  function disabled(element) {
    return Boolean(element.disabled)
      || element.getAttribute('aria-disabled') === 'true'
      || Boolean(element.closest?.('[aria-disabled="true"]'));
  }

  function submitsForm(element) {
    if (element.tagName === 'INPUT') {
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      return type === 'submit' || type === 'image';
    }
    if (element.tagName === 'BUTTON') {
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      if (type === 'submit') return true;
      return !type && Boolean(element.form);
    }
    return false;
  }

  function linkOf(element) {
    const anchor = element.closest?.('a[href]');
    if (!anchor) return null;
    const href = anchor.href;
    return /^https?:\/\//iu.test(href) ? href : null;
  }

  function valueOf(element, full = false) {
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    if (type === 'password') return null;
    // 300 = VALUE_CHAR_LIMIT in target-state.js; this injected script cannot import it.
    if (element.isContentEditable) {
      const text = element.innerText ?? '';
      return full ? text : clean(text).slice(0, 300);
    }
    if ('value' in element) {
      const raw = String(element.value ?? '');
      return full ? raw : raw.slice(0, 300);
    }
    return null;
  }

  function appearanceOf(element) {
    const className = String(element.getAttribute('class') ?? '').slice(0, 120);
    const inline = String(element.getAttribute('style') ?? '').slice(0, 160);
    return `${className}\u0000${inline}`;
  }

  function styleStateOf(element) {
    let style;
    try {
      style = getComputedStyle(element);
    } catch {
      return null;
    }
    return {
      className: String(element.getAttribute('class') ?? '').slice(0, 80),
      backgroundColor: style.backgroundColor,
      color: style.color,
      borderColor: style.borderColor,
    };
  }

  function focusableOf(element) {
    if (element.tabIndex < 0) return false;
    if (element.disabled) return false;
    return visible(element);
  }

  function focusedOf(element) {
    const root = element.getRootNode?.();
    const active = root?.activeElement ?? document.activeElement;
    return active === element;
  }

  // A layout TD's whole content is not a column label; only real header cells
  // (th or explicit header roles) may name a column or row.
  function headerRoleOf(cell) {
    const role = (cell.getAttribute('role') ?? '').toLowerCase();
    if (role === 'columnheader') return 'column';
    if (role === 'rowheader') return 'row';
    if (cell.tagName !== 'TH') return null;
    const scope = (cell.getAttribute('scope') ?? '').toLowerCase();
    if (scope === 'row' || scope === 'rowgroup') return 'row';
    if (scope === 'col' || scope === 'colgroup') return 'column';
    return cell.cellIndex === 0 ? 'row' : 'column';
  }

  function columnHeaderOf(cell) {
    const index = cell.cellIndex ?? -1;
    if (index < 0) return null;
    const table = cell.closest('table');
    if (!table) return null;
    for (const row of table.rows ?? []) {
      const candidate = row.cells?.[index];
      if (!candidate || candidate === cell) continue;
      if (headerRoleOf(candidate) === 'column') return candidate;
    }
    return null;
  }

  function rowHeaderOf(cell) {
    const row = cell.parentElement;
    if (!row) return null;
    for (const candidate of row.cells ?? []) {
      if (candidate === cell) continue;
      if (headerRoleOf(candidate) === 'row') return candidate;
    }
    return null;
  }

  function tableLabels(element) {
    const cell = element.closest?.('td,th');
    if (!cell) return null;
    const column = columnHeaderOf(cell);
    const row = rowHeaderOf(cell);
    const columnText = column ? clean(column.innerText).slice(0, MAX_NEAR_CHARS) : '';
    const rowText = row ? clean(row.innerText).slice(0, MAX_NEAR_CHARS) : '';
    if (!columnText && !rowText) return null;
    const box = (target) => {
      if (!target) return null;
      const area = target.getBoundingClientRect();
      return { x: Math.round(area.x), y: Math.round(area.y), width: Math.round(area.width), height: Math.round(area.height) };
    };
    return {
      above: columnText ? { text: columnText, rect: box(column) } : null,
      left: rowText ? { text: rowText, rect: box(row) } : null,
    };
  }

  // Rendered text lines inside a box, one entry per visual line. Labels are
  // matched to controls by where their text is drawn, not by which element
  // holds it: one element often holds a whole column of labels.
  function lineBox(rect, text) {
    return {
      text,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      height: rect.height,
      width: rect.width,
    };
  }

  function boxesMeet(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function textLines(box, excluded = new Set()) {
    const lines = [];
    if (!document.body) return lines;
    const roots = [document.body];
    for (const element of deepElements()) {
      if (element.shadowRoot && !isLauncher(element)) roots.push(element.shadowRoot);
    }
    const shown = new Map();
    const parentShown = (parent) => {
      if (!shown.has(parent)) {
        let ok = !SKIP_TAGS.has(parent.tagName) && visible(parent);
        for (let node = parent, depth = 0; ok && node && depth < 12; depth += 1) {
          if (excluded.has(node)) ok = false;
          node = node.parentElement;
        }
        shown.set(parent, ok);
      }
      return shown.get(parent);
    };
    const range = document.createRange();
    let budget = 20_000;
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && budget > 0; node = walker.nextNode()) {
        budget -= 1;
        const text = clean(node.data);
        if (!text) continue;
        const parent = node.parentElement;
        if (!parent) continue;
        const outer = parent.getBoundingClientRect();
        if (!boxesMeet(outer, box)) continue;
        if (!parentShown(parent)) continue;
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
        if (!rects.length) continue;
        if (rects.length === 1) {
          const line = lineBox(rects[0], text.slice(0, MAX_NEAR_CHARS));
          if (boxesMeet(line, box)) lines.push(line);
          continue;
        }
        // One text node drawn on several lines: rebuild each line from words.
        let current = null;
        const flush = () => {
          if (!current) return;
          const line = lineBox(current.rect, clean(current.words.join(' ')).slice(0, MAX_NEAR_CHARS));
          if (line.text && boxesMeet(line, box)) lines.push(line);
        };
        for (const match of node.data.matchAll(/\S+/gu)) {
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rect = range.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (current && Math.abs(rect.top - current.rect.top) <= Math.max(2, rect.height / 2)) {
            current.words.push(match[0]);
            const left = Math.min(current.rect.left, rect.left);
            const right = Math.max(current.rect.right, rect.right);
            const top = Math.min(current.rect.top, rect.top);
            const bottom = Math.max(current.rect.bottom, rect.bottom);
            current.rect = { left, right, top, bottom, width: right - left, height: bottom - top };
          } else {
            flush();
            current = { words: [match[0]], rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } };
          }
        }
        flush();
      }
    }
    return lines;
  }

  function roundBox(line) {
    return { x: Math.round(line.left), y: Math.round(line.top), width: Math.round(line.width), height: Math.round(line.height) };
  }

  // The nearest drawn text line above and the nearest to the left of a control.
  function lineLabels(rect, lines) {
    let above = null;
    let left = null;
    let aboveGap = Infinity;
    let leftGap = Infinity;
    for (const line of lines) {
      const overGap = rect.top - line.bottom;
      if (overGap >= -2 && overGap <= 100 && line.right > rect.left && line.left < rect.right && overGap < aboveGap) {
        above = line;
        aboveGap = overGap;
      }
      const sideGap = rect.left - line.right;
      if (sideGap >= -2 && sideGap <= 200 && line.cy >= rect.top - 2 && line.cy <= rect.bottom + 2 && sideGap < leftGap) {
        left = line;
        leftGap = sideGap;
      }
    }
    if (!above && !left) return null;
    return {
      above: above ? { text: above.text, rect: roundBox(above) } : null,
      left: left ? { text: left.text, rect: roundBox(left) } : null,
    };
  }

  const GRID_SIZE_TOLERANCE = 2;
  const GRID_AXIS_TOLERANCE = 3;
  const GRID_MIN_FILL = 0.8;
  const MAX_GRID_CELLS = 2000;
  const MAX_TARGETS = 200;

  function clusterAxis(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const centers = [];
    let group = [];
    const close = () => {
      if (group.length) centers.push(group.reduce((sum, value) => sum + value, 0) / group.length);
      group = [];
    };
    for (const value of sorted) {
      if (group.length && value - group[group.length - 1] > GRID_AXIS_TOLERANCE) close();
      group.push(value);
    }
    close();
    return centers;
  }

  function nearestIndex(centers, value) {
    let best = 0;
    for (let index = 1; index < centers.length; index += 1) {
      if (Math.abs(centers[index] - value) < Math.abs(centers[best] - value)) best = index;
    }
    return best;
  }

  // Runs of evenly spaced centers; a gap much wider than a cell starts a new run.
  function splitRuns(centers, size) {
    const runs = [];
    let run = [];
    for (const center of centers) {
      if (run.length && center - run[run.length - 1] > Math.max(size * 1.8, size + 8)) {
        runs.push(run);
        run = [];
      }
      run.push(center);
    }
    if (run.length) runs.push(run);
    return runs;
  }

  // Unnamed controls of one size laid out in rows and columns (a schedule,
  // a seat map, a calendar of bare cells). Each grid is reported once with the
  // text drawn along its top and left edge, so every cell has a row and a column.
  function detectGrids(targets) {
    const groups = [];
    for (const target of targets) {
      if (target.kind !== 'custom-control' || target.name || target.role === 'region') continue;
      const { width, height } = target.rect;
      if (width < 4 || height < 4) continue;
      let group = groups.find((candidate) => Math.abs(candidate.width - width) <= GRID_SIZE_TOLERANCE
        && Math.abs(candidate.height - height) <= GRID_SIZE_TOLERANCE);
      if (!group) {
        group = { width, height, members: [] };
        groups.push(group);
      }
      group.members.push(target);
    }
    const grids = [];
    for (const group of groups) {
      if (group.members.length < 4) continue;
      const center = (target) => ({
        x: target.rect.x + target.rect.width / 2,
        y: target.rect.y + target.rect.height / 2,
      });
      const xs = clusterAxis(group.members.map((target) => center(target).x));
      const ys = clusterAxis(group.members.map((target) => center(target).y));
      for (const columnRun of splitRuns(xs, group.width)) {
        for (const rowRun of splitRuns(ys, group.height)) {
          const cells = rowRun.map(() => columnRun.map(() => null));
          let count = 0;
          for (const target of group.members) {
            const point = center(target);
            const column = nearestIndex(columnRun, point.x);
            const row = nearestIndex(rowRun, point.y);
            if (Math.abs(columnRun[column] - point.x) > GRID_AXIS_TOLERANCE * 2) continue;
            if (Math.abs(rowRun[row] - point.y) > GRID_AXIS_TOLERANCE * 2) continue;
            if (cells[row][column] !== null) continue;
            cells[row][column] = target;
            count += 1;
          }
          const size = rowRun.length * columnRun.length;
          if (count < 4 || count / size < GRID_MIN_FILL) continue;
          // A short single row or column (seven weekday boxes) reads fine with
          // per-control labels; a long one is one day's list of time slots.
          const lattice = rowRun.length >= 2 && columnRun.length >= 2;
          if (!lattice && Math.max(rowRun.length, columnRun.length) < 8) continue;
          grids.push({
            cells,
            columns: columnRun,
            rows: rowRun,
            cellWidth: group.width,
            cellHeight: group.height,
          });
        }
      }
    }
    grids.sort((a, b) => (a.rows[0] - b.rows[0]) || (a.columns[0] - b.columns[0]));
    return grids;
  }

  function gridBounds(grid) {
    return {
      left: grid.columns[0] - grid.cellWidth / 2,
      right: grid.columns[grid.columns.length - 1] + grid.cellWidth / 2,
      top: grid.rows[0] - grid.cellHeight / 2,
      bottom: grid.rows[grid.rows.length - 1] + grid.cellHeight / 2,
    };
  }

  function pitchOf(centers, size) {
    return centers.length > 1 ? (centers[centers.length - 1] - centers[0]) / (centers.length - 1) : size;
  }

  // Column labels: text drawn just above a column and no wider than about one
  // column, stacked lines joined top to bottom ("Nov 26" over "Thu").
  function columnLabelsOf(grid, bounds, lines) {
    const pitch = pitchOf(grid.columns, grid.cellWidth);
    let labelTop = bounds.top;
    const labels = grid.columns.map((center) => {
      const left = center - pitch / 2;
      const right = center + pitch / 2;
      const candidates = lines
        .filter((line) => line.bottom <= bounds.top + 2 && line.bottom >= bounds.top - 100
          && line.cx >= left && line.cx <= right
          && line.left >= left - pitch / 2 && line.right <= right + pitch / 2)
        .sort((a, b) => b.bottom - a.bottom);
      const stack = [];
      for (const line of candidates) {
        const nearest = stack.length ? stack[stack.length - 1] : null;
        if (!nearest) {
          if (bounds.top - line.bottom > 40) break;
        } else if (nearest.top - line.bottom > Math.max(4, nearest.height * 0.6)) break;
        stack.push(line);
      }
      if (stack.length) labelTop = Math.min(labelTop, stack[stack.length - 1].top);
      return stack.reverse().map((line) => line.text).join(' ');
    });
    return { labels, labelTop };
  }

  // Row labels: text drawn left of the grid. A label either sits inside its
  // row or on the line where its row starts; whichever the labels do as a
  // group decides how each one is assigned.
  function rowLabelsOf(grid, bounds, lines) {
    const pitch = pitchOf(grid.rows, grid.cellHeight);
    const candidates = lines.filter((line) => line.right <= bounds.left + 2
      && line.right >= bounds.left - 220
      && line.cy >= bounds.top - pitch && line.cy <= bounds.bottom + pitch
      && line.height <= pitch * 4 + 16);
    if (!candidates.length) return { labels: [], at: null, perLabel: null };
    const offsets = candidates.map((line) => (line.cy - bounds.top) / pitch);
    const drift = offsets.map((offset) => Math.abs(offset - Math.round(offset))).sort((a, b) => a - b);
    const onEdges = drift[Math.floor(drift.length / 2)] < 0.25;
    const byRow = new Map();
    candidates.forEach((line, index) => {
      const row = onEdges ? Math.round(offsets[index]) : Math.floor(offsets[index]);
      if (row < 0 || row > grid.rows.length) return;
      const previous = byRow.get(row);
      if (!previous || line.right > previous.right) byRow.set(row, line);
    });
    const labels = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([row, line]) => ({ row, text: line.text }));
    let perLabel = null;
    if (labels.length >= 3) {
      const steps = new Set();
      for (let index = 1; index < labels.length; index += 1) steps.add(labels[index].row - labels[index - 1].row);
      if (steps.size === 1) perLabel = [...steps][0];
    }
    return { labels, at: onEdges ? 'row-top-edge' : 'row', perLabel };
  }

  function captionOf(bounds, labelTop, lines) {
    let best = null;
    for (const line of lines) {
      const gap = labelTop - line.bottom;
      if (gap < 0 || gap > 60) continue;
      if (line.right <= bounds.left || line.left >= bounds.right) continue;
      if (!best || gap < labelTop - best.bottom) best = line;
    }
    return best?.text ?? '';
  }

  function labelGrid(grid, lines) {
    const bounds = gridBounds(grid);
    const columns = columnLabelsOf(grid, bounds, lines);
    const rows = rowLabelsOf(grid, bounds, lines);
    return {
      bounds,
      columnLabels: columns.labels,
      rowLabels: rows.labels,
      rowLabelsAt: rows.at,
      rowsPerLabel: rows.perLabel,
      caption: captionOf(bounds, columns.labelTop, lines),
    };
  }

  function nearLabels(element, lines) {
    return tableLabels(element) ?? (lines ? lineLabels(element.getBoundingClientRect(), lines) : null);
  }

  function sensitiveRects() {
    const rects = [];
    for (const element of deepElements()) {
      if (element.tagName !== 'INPUT') continue;
      if ((element.getAttribute('type') ?? '').toLowerCase() !== 'password') continue;
      if (!visible(element)) continue;
      const rect = rectOf(element);
      if (rect.width < 1 || rect.height < 1) continue;
      rects.push({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height });
    }
    return rects;
  }

  function stateOf(element, { fullValue = false } = {}) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    const role = roleOf(element);
    const rect = rectOf(element);
    const checkable = (tag === 'input' && (type === 'checkbox' || type === 'radio'))
      || ['checkbox', 'radio', 'switch'].includes(role);
    const editable = tag === 'textarea' || element.isContentEditable
      || (tag === 'input' && TEXTUAL.has(type || 'text'));
    const selectable = tag === 'select';
    return {
      docToken,
      tag,
      type: type || null,
      role,
      name: nameOf(element).slice(0, 200),
      disabled: disabled(element),
      visible: visible(element),
      inViewport: inViewport(rect),
      editable,
      readOnly: readOnlyOf(element),
      contentEditable: element.isContentEditable === true,
      checkable,
      selectable,
      submits: submitsForm(element),
      focusable: focusableOf(element),
      focused: focusedOf(element),
      link: linkOf(element),
      alt: tag === 'img' ? { present: element.hasAttribute('alt'), value: element.getAttribute('alt') ?? '' } : null,
      value: editable ? valueOf(element, fullValue) : null,
      checked: tag === 'input' && (type === 'checkbox' || type === 'radio') ? element.checked : null,
      ariaChecked: element.getAttribute('aria-checked'),
      ariaExpanded: element.getAttribute('aria-expanded'),
      ariaSelected: element.getAttribute('aria-selected'),
      ariaPressed: element.getAttribute('aria-pressed'),
      styleState: styleStateOf(element),
      appearance: appearanceOf(element),
      selected: selectable ? [...element.selectedOptions].map((option) => option.value) : null,
      options: selectable
        ? [...element.options].slice(0, 50).map((option) => ({
          value: option.value,
          label: clean(option.textContent).slice(0, 80),
          selected: option.selected,
        }))
        : null,
      rect,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    };
  }

  function textOf(element, full = false) {
    if (element.tagName === 'IMG') {
      return clean(element.getAttribute('alt')) || '[image has no alt text]';
    }
    if (element.tagName === 'CANVAS' || element.tagName === 'SVG') return '[image]';
    if (element.tagName === 'SELECT') {
      return [...element.selectedOptions].map((option) => clean(option.textContent)).join(', ');
    }
    if ('value' in element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) {
      return valueOf(element, full) ?? '';
    }
    return full ? clean(element.innerText) : clean(element.innerText).slice(0, 3000);
  }

  function sectionOf(element) {
    let current = element.parentElement;
    while (current) {
      const landmark = current.getAttribute('role');
      if (['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'dialog', 'form'].includes(landmark)) {
        return clean(current.getAttribute('aria-label')) || landmark;
      }
      const tag = current.tagName;
      if (tag === 'MAIN' || tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE' || tag === 'FORM' || tag === 'DIALOG') {
        return clean(current.getAttribute('aria-label')) || tag.toLowerCase();
      }
      current = current.parentElement;
    }
    return 'Body';
  }

  function isImage(element) {
    return element.tagName === 'IMG' || element.tagName === 'CANVAS'
      || (element.tagName === 'SVG' && !element.closest(INTERACTIVE));
  }

  // The launcher records its real host in the isolated world; a page ID or
  // arbitrary same-named element never identifies our control.
  function launcherHost() {
    const host = globalThis.__accessAssistLauncher?.host;
    return host?.isConnected ? host : null;
  }

  function isLauncher(element) {
    const host = launcherHost();
    if (!host) return false;
    let node = element;
    let guard = 0;
    while (node && guard < 10_000) {
      guard += 1;
      if (node === host) return true;
      node = node.parentElement ?? node.getRootNode?.()?.host ?? null;
    }
    return false;
  }

  function decorativeImage(element) {
    return element.tagName === 'IMG' && element.hasAttribute('alt')
      && element.getAttribute('alt') === ''
      && !element.matches(INTERACTIVE);
  }

  function largeImage(element) {
    const rect = element.getBoundingClientRect();
    return rect.width >= 40 && rect.height >= 40;
  }

  function collectItems() {
    const items = [];
    const visit = (parent) => {
      const children = [...(parent.children ?? [])];
      if (parent.shadowRoot) children.push(...parent.shadowRoot.children);
      for (const element of children) {
        if (SKIP_TAGS.has(element.tagName) || isLauncher(element)) continue;
        if (!visible(element)) continue;
        if (TEXT_BLOCKS.has(element.tagName) || ['heading', 'paragraph', 'listitem'].includes(element.getAttribute('role') ?? '')) {
          const text = clean(element.innerText);
          if (text) {
            items.push({
              nodeId: idFor(element),
              section: sectionOf(element),
              role: roleOf(element),
              name: nameOf(element).slice(0, 200),
              text: text.slice(0, 3000),
            });
          }
          continue;
        }
        if (element.matches(INTERACTIVE)) {
          const text = textOf(element);
          const name = nameOf(element).slice(0, 200);
          if (name || text) {
            items.push({ nodeId: idFor(element), section: sectionOf(element), role: roleOf(element), name, text: text.slice(0, 1000) });
          }
          continue;
        }
        if (isImage(element) && largeImage(element)) {
          if (decorativeImage(element)) continue;
          items.push({
            nodeId: idFor(element),
            section: sectionOf(element),
            role: 'img',
            name: nameOf(element).slice(0, 200) || '[image]',
            text: element.tagName === 'IMG' ? clean(element.getAttribute('alt')) : '[image]',
          });
          continue;
        }
        visit(element);
      }
    };
    if (document.body) visit(document.body);
    return items;
  }

  function deepElements() {
    const all = [];
    const walk = (root) => {
      for (const element of root.children ?? []) {
        all.push(element);
        if (element.shadowRoot) walk(element.shadowRoot);
        walk(element);
      }
    };
    walk(document);
    return all;
  }

  function isNativeControl(element) {
    return ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(element.tagName)
      || element.isContentEditable;
  }

  function readOnlyOf(element) {
    return Boolean(element.readOnly)
      || element.getAttribute('aria-readonly') === 'true'
      || Boolean(element.closest?.('[aria-readonly="true"]'));
  }

  function capabilitiesOf(element) {
    let cursor = 'auto';
    let overflowX = 'visible';
    let overflowY = 'visible';
    try {
      const style = getComputedStyle(element);
      cursor = style.cursor;
      overflowX = style.overflowX;
      overflowY = style.overflowY;
    } catch {}
    const scrollable = (overflow, main, client) => ['auto', 'scroll', 'overlay'].includes(overflow)
      && main > client + 1;
    return {
      press: Boolean(element.onclick) || element.hasAttribute('onclick')
        || element.hasAttribute('onmousedown') || element.hasAttribute('onpointerdown'),
      hover: element.hasAttribute('onmouseover') || element.hasAttribute('onmouseenter')
        || element.hasAttribute('onpointerover'),
      drag: element.hasAttribute('draggable') || element.hasAttribute('ondragstart')
        || element.hasAttribute('onpointermove') || element.hasAttribute('onmousemove'),
      focus: focusableOf(element),
      cursor,
      scrollX: scrollable(overflowX, element.scrollWidth, element.clientWidth),
      scrollY: scrollable(overflowY, element.scrollHeight, element.clientHeight),
    };
  }

  function pointerCandidate(element) {
    if (isLauncher(element) || SKIP_TAGS.has(element.tagName)) return false;
    if (element.matches(INTERACTIVE) || element.closest(INTERACTIVE)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    if (!visible(element)) return false;
    let cursor;
    try {
      cursor = getComputedStyle(element).cursor;
    } catch {
      return false;
    }
    if (!CURSORS.has(cursor)) return false;
    // Inherited pointer styling denotes a container, not the control itself.
    try {
      if (element.parentElement && getComputedStyle(element.parentElement).cursor === cursor) return false;
    } catch {}
    return true;
  }

  function describeTarget(element, extra = {}) {
    const target = { ...stateOf(element), ...extra };
    target.capabilities = capabilitiesOf(element);
    return target;
  }

  function collectTargets() {
    const targets = [];
    const seen = new Set();
    const selector = `${INTERACTIVE},${IMAGES}`;
    const elements = deepElements();
    for (const element of elements) {
      if (!element.matches(selector)) continue;
      if (isLauncher(element) || SKIP_TAGS.has(element.tagName)) continue;
      if (element.tagName === 'INPUT' && (element.getAttribute('type') ?? '').toLowerCase() === 'hidden') continue;
      if (!visible(element)) continue;
      if (element.tagName === 'SVG' && element.closest(INTERACTIVE)) continue;
      if (isImage(element) && !element.matches(INTERACTIVE) && (!largeImage(element) || decorativeImage(element))) continue;
      const nodeId = idFor(element);
      const kind = isImage(element) ? 'image' : isNativeControl(element) ? 'native-control' : 'custom-control';
      targets.push({ nodeId, ...describeTarget(element, { kind }) });
      seen.add(nodeId);
    }
    let extraCount = 0;
    for (const element of elements) {
      if (extraCount >= 80) break;
      if (element.matches(INTERACTIVE)) continue;
      const capabilities = capabilitiesOf(element);
      if (!capabilities.scrollX && !capabilities.scrollY) continue;
      if (!inViewport(rectOf(element))) continue;
      const nodeId = idFor(element);
      if (seen.has(nodeId)) continue;
      extraCount += 1;
      targets.push({
        nodeId,
        ...describeTarget(element, { kind: 'custom-control', role: 'region' }),
      });
      seen.add(nodeId);
    }
    let pointerCount = 0;
    for (const element of elements) {
      if (extraCount + pointerCount >= 80) break;
      if (!pointerCandidate(element)) continue;
      const nodeId = idFor(element);
      if (seen.has(nodeId)) continue;
      pointerCount += 1;
      targets.push({
        nodeId,
        ...describeTarget(element, { kind: 'custom-control', role: 'button' }),
      });
      seen.add(nodeId);
    }
    return targets;
  }

  function groupSections(items) {
    const sections = [];
    for (const item of items) {
      let section = sections.at(-1);
      if (!section || section.name !== item.section) {
        section = { name: item.section, items: [] };
        sections.push(section);
      }
      section.items.push({ nodeId: item.nodeId, role: item.role, name: item.name, text: item.text });
    }
    return sections;
  }

  function observe({ cursor, visual = false } = {}) {
    const allItems = collectItems();
    const allTargets = collectTargets();
    const start = Math.max(0, Number(cursor) || 0);
    const slice = [];
    let used = 0;
    let index = start;
    for (; index < allItems.length; index += 1) {
      const item = allItems[index];
      const size = item.name.length + item.text.length + 40;
      if (used + size > 40000 && slice.length > 0) break;
      slice.push(item);
      used += size;
    }
    const sliceIds = new Set(slice.map((item) => item.nodeId));
    // A grid on screen is reported whole, cells below the fold included: the
    // click path scrolls each cell into view, and a half grid would hide rows.
    const grids = [];
    const gridCellIds = new Set();
    let gridBudget = MAX_GRID_CELLS;
    for (const grid of detectGrids(allTargets)) {
      const members = grid.cells.flat().filter(Boolean);
      if (!members.some((target) => target.inViewport)) continue;
      let rows = grid.cells;
      let partial = false;
      if (members.length > gridBudget) {
        const keep = Math.floor(gridBudget / grid.columns.length);
        if (keep < 1) break;
        rows = rows.slice(0, keep);
        partial = true;
      }
      for (const row of rows) for (const cell of row) if (cell) gridCellIds.add(cell.nodeId);
      gridBudget -= rows.flat().filter(Boolean).length;
      grids.push({ ...grid, cells: rows, rows: grid.rows.slice(0, rows.length), partial });
    }
    const others = allTargets
      .filter((target) => !gridCellIds.has(target.nodeId) && (target.inViewport || sliceIds.has(target.nodeId)));
    const targets = others.slice(0, MAX_TARGETS);
    const omittedTargets = others.length - targets.length;
    const unnamed = targets.filter((target) => !target.name && target.kind === 'custom-control');
    if (grids.length || unnamed.length) {
      const excluded = new Set([...gridCellIds].map((id) => nodes.get(id)).filter(Boolean));
      const around = { left: -220, top: -120, right: window.innerWidth + 20, bottom: window.innerHeight + 20 };
      for (const grid of grids) {
        const bounds = gridBounds(grid);
        around.top = Math.min(around.top, bounds.top - 120);
        around.bottom = Math.max(around.bottom, bounds.bottom + 20);
      }
      const lines = textLines(around, excluded);
      for (const target of unnamed) {
        const element = nodes.get(target.nodeId);
        if (element) target.near = nearLabels(element, lines);
      }
      for (const grid of grids) Object.assign(grid, labelGrid(grid, lines));
      // A grid split off by a visual gap (dates that are not consecutive)
      // shares its rows with the grid to its left and takes those row labels.
      for (const grid of grids) {
        if (grid.rowLabels.length) continue;
        const twin = grids.find((other) => other !== grid && other.rowLabels.length
          && other.bounds.right <= grid.bounds.left
          && other.rows.length === grid.rows.length
          && other.rows.every((center, index) => Math.abs(center - grid.rows[index]) <= GRID_AXIS_TOLERANCE));
        if (twin) Object.assign(grid, { rowLabels: twin.rowLabels, rowLabelsAt: twin.rowLabelsAt, rowsPerLabel: twin.rowsPerLabel });
      }
    }
    for (const target of allTargets) if (gridCellIds.has(target.nodeId)) targets.push(target);
    const snapshotId = crypto.randomUUID();
    if (visual) {
      visualNodeId = idFor(document.documentElement);
      targets.push({
        nodeId: visualNodeId,
        kind: 'visual-region',
        role: '',
        name: '',
        tag: 'html',
        type: null,
        disabled: false,
        visible: true,
        inViewport: true,
        editable: false,
        readOnly: false,
        contentEditable: false,
        checkable: false,
        selectable: false,
        submits: false,
        focusable: false,
        focused: false,
        link: null,
        alt: null,
        value: null,
        checked: null,
        ariaChecked: null,
        ariaExpanded: null,
        ariaSelected: null,
        ariaPressed: null,
        styleState: null,
        appearance: `visual:${docToken}`,
        selected: null,
        options: null,
        capabilities: { press: false, hover: false, drag: false, focus: false, cursor: 'auto' },
        rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      });
    }
    const snapshot = {
      snapshotId,
      createdAt: Date.now(),
      nodeIds: new Set([...slice.map((item) => item.nodeId), ...targets.map((target) => target.nodeId)]),
    };
    snapshots.set(snapshotId, snapshot);
    while (snapshots.size > 5) {
      const oldest = snapshots.keys().next().value;
      snapshots.delete(oldest);
    }
    // Strong element references exist only for targets the five newest
    // snapshots can still resolve.
    const retained = new Set();
    for (const candidate of snapshots.values()) {
      for (const id of candidate.nodeIds) retained.add(id);
    }
    for (const id of nodes.keys()) {
      if (!retained.has(id)) nodes.delete(id);
    }
    return {
      snapshotId,
      docToken,
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      sections: groupSections(slice),
      targets: targets.map((target) => ({ ...target, docToken, snapshotId })),
      nextCursor: index < allItems.length ? String(index) : null,
      grids: grids.map((grid) => ({
        caption: grid.caption,
        columnLabels: grid.columnLabels,
        rowLabels: grid.rowLabels,
        rowLabelsAt: grid.rowLabelsAt,
        rowsPerLabel: grid.rowsPerLabel,
        partial: grid.partial,
        cells: grid.cells.map((row) => row.map((cell) => cell?.nodeId ?? null)),
      })),
      omittedTargets,
      blockedFrames: [],
      visual: visual ? {
        nodeId: visualNodeId,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: window.scrollX, y: window.scrollY },
        dpr: window.devicePixelRatio,
      } : null,
    };
  }

  function elementFor(snapshotId, nodeId) {
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot || !snapshot.nodeIds.has(nodeId)) return null;
    const element = nodes.get(nodeId);
    return element?.isConnected ? element : null;
  }

  function readTarget({ snapshotId, nodeId, cursor }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    if (type === 'password') return { error: 'Password fields are not read' };
    const text = textOf(element, true);
    const offset = Math.max(0, Number(cursor) || 0);
    const chunk = text.slice(offset, offset + 8000);
    return {
      exists: true,
      docToken,
      name: nameOf(element).slice(0, 200),
      role: roleOf(element),
      text: chunk,
      nextCursor: offset + 8000 < text.length ? String(offset + 8000) : null,
      state: stateOf(element),
    };
  }

  function focusTarget({ snapshotId, nodeId }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    // Nearest scrolling keeps neighboring layout targets where they were.
    const rect = rectOf(element);
    const inside = rect.x >= 0 && rect.y >= 0
      && rect.x + rect.width <= window.innerWidth && rect.y + rect.height <= window.innerHeight;
    if (!inside) element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (typeof element.focus === 'function') {
      try {
        element.focus({ preventScroll: true });
      } catch {
        element.focus();
      }
    }
    if (!focusedOf(element)) return { error: 'Focus did not move to the target; observe again.' };
    return { ok: true, docToken, state: stateOf(element) };
  }

  function scrollableBy(element, axis) {
    if (element === document.documentElement || element === document.body) return false;
    let style;
    try {
      style = getComputedStyle(element);
    } catch {
      return false;
    }
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;
    if (!['auto', 'scroll', 'overlay'].includes(overflow)) return false;
    return axis === 'x'
      ? element.scrollWidth > element.clientWidth + 1
      : element.scrollHeight > element.clientHeight + 1;
  }

  function scrollContainerFor(element, axis) {
    let node = element;
    let guard = 0;
    while (node && guard < 200) {
      guard += 1;
      if (scrollableBy(node, axis)) return node;
      const root = node.getRootNode?.();
      node = node.parentElement ?? (root?.host ?? null);
    }
    return null;
  }

  function scrollPage({ direction, snapshotId, nodeId }) {
    if (!['up', 'down', 'left', 'right'].includes(direction)) return { error: 'Unsupported scroll direction' };
    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
    const sign = direction === 'up' || direction === 'left' ? -1 : 1;
    if (snapshotId !== undefined || nodeId !== undefined) {
      const element = elementFor(snapshotId, nodeId);
      if (!element) return { error: 'Target no longer exists; observe the page again' };
      const scroller = scrollContainerFor(element, axis);
      if (!scroller) return { error: 'That target has no scrollable container in this direction.' };
      const size = axis === 'x' ? scroller.clientWidth : scroller.clientHeight;
      const step = Math.max(1, Math.floor(size * 0.9));
      const before = axis === 'x' ? scroller.scrollLeft : scroller.scrollTop;
      scroller.scrollBy({ left: axis === 'x' ? sign * step : 0, top: axis === 'y' ? sign * step : 0, behavior: 'instant' });
      const after = axis === 'x' ? scroller.scrollLeft : scroller.scrollTop;
      return {
        ok: true,
        moved: after !== before,
        scrollLeft: scroller.scrollLeft,
        scrollTop: scroller.scrollTop,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        docToken,
      };
    }
    const step = Math.max(1, Math.floor((axis === 'x' ? window.innerWidth : window.innerHeight) * 0.9));
    const before = axis === 'x' ? window.scrollX : window.scrollY;
    window.scrollBy({ left: axis === 'x' ? sign * step : 0, top: axis === 'y' ? sign * step : 0, behavior: 'instant' });
    const after = axis === 'x' ? window.scrollX : window.scrollY;
    return {
      ok: true,
      moved: after !== before,
      scrollLeft: 0,
      scrollTop: 0,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      docToken,
    };
  }

  function scrollToTarget({ snapshotId, nodeId }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    // Layouts that re-center on every scroll would move neighboring targets.
    const rect = rectOf(element);
    const inside = rect.x >= 0 && rect.y >= 0
      && rect.x + rect.width <= window.innerWidth && rect.y + rect.height <= window.innerHeight;
    if (!inside) element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return { ok: true, docToken, state: { exists: true, ...stateOf(element) } };
  }

  function nativeValueSetter(element) {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    return descriptor?.set?.bind(element);
  }

  function fire(element, types) {
    for (const type of types) {
      element.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
  }

  const SEGMENTED = new Set(['number', 'date', 'datetime-local', 'month', 'week', 'time']);
  const ORDINARY = new Set(['text', 'search', 'email', 'tel', 'url']);

  function textKind(element) {
    const tag = element.tagName.toLowerCase();
    if (element.isContentEditable) return 'rich';
    if (tag === 'textarea') return 'ordinary';
    if (tag !== 'input') return null;
    const type = (element.getAttribute('type') ?? 'text').toLowerCase() || 'text';
    if (ORDINARY.has(type)) return 'ordinary';
    if (SEGMENTED.has(type)) return 'segmented';
    return null;
  }

  function prepareText({ snapshotId, nodeId, expected }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    const state = stateOf(element);
    if (!state.editable) return { error: 'Target does not accept text input' };
    if (state.readOnly) return { error: 'The field is read-only' };
    if (!state.visible) return { error: 'Target is not visible' };
    const kind = textKind(element);
    if (!kind) return { error: 'Target does not accept text input' };
    const before = valueOf(element, true);
    if (before === null) return { error: 'This field cannot be read safely' };
    if (typeof expected === 'string' && before !== expected) {
      return { error: 'text_conflict' };
    }
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
    if (!focusedOf(element)) return { error: 'The text target lost focus; observe again.' };
    if (kind !== 'segmented') {
      if (kind === 'rich') {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = element.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        if (!selection || selection.rangeCount === 0 || (selection.isCollapsed && before !== '')) {
          return { error: 'The text target lost its selection; observe again.' };
        }
      } else {
        element.select();
        if (before !== '' && typeof element.selectionStart === 'number'
          && (element.selectionStart !== 0 || element.selectionEnd !== before.length)) {
          return { error: 'The text target lost its selection; observe again.' };
        }
      }
      // A focus handler may have handed focus to another field.
      if (!focusedOf(element)) return { error: 'The text target lost focus; observe again.' };
    }
    return { ok: true, docToken, before, kind, rich: kind === 'rich' };
  }

  function finishText({ snapshotId, nodeId, blur = true }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    if (blur && focusedOf(element)) element.blur();
    const state = stateOf(element, { fullValue: true });
    return { ok: true, docToken, value: state.value, state };
  }

  function blurTarget({ snapshotId, nodeId }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    if (!focusedOf(element)) return { ok: true, docToken, changed: false, focused: false };
    element.blur();
    return { ok: true, docToken, changed: true, focused: focusedOf(element) };
  }

  function setValue({ snapshotId, nodeId, value }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    const state = stateOf(element);
    if (!state.editable) return { error: 'Target does not accept text input' };
    if (state.readOnly) return { error: 'The field is read-only' };
    if (textKind(element) !== 'segmented') return { error: 'This field needs the browser text path' };
    const before = stateOf(element, { fullValue: true }).value;
    element.focus({ preventScroll: true });
    const setter = nativeValueSetter(element);
    if (setter) setter(value);
    else element.value = value;
    fire(element, ['input', 'change']);
    return { ok: true, docToken, before, after: stateOf(element, { fullValue: true }).value };
  }

  function setChecked({ snapshotId, nodeId, checked }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    const before = stateOf(element);
    if (!before.checkable) return { error: 'Target is not a checkable control' };
    let previousRadio = null;
    if (element.tagName === 'INPUT') {
      // Checking one radio silently unchecks its group, so remember the sibling
      // the browser will clear and let undo restore it.
      const previous = checked && element.type === 'radio' && element.name
        ? [...element.getRootNode().querySelectorAll('input[type="radio"]')].find((node) => node !== element
          && node.checked && node.name === element.name && node.form === element.form) ?? null
        : null;
      element.checked = checked;
      fire(element, ['input', 'change']);
      if (previous && !previous.checked) {
        previousRadio = idFor(previous);
        snapshots.get(snapshotId)?.nodeIds.add(previousRadio);
      }
    } else {
      element.setAttribute('aria-checked', checked ? 'true' : 'false');
      fire(element, ['input', 'change']);
    }
    return { ok: true, docToken, before, after: stateOf(element), previousRadio };
  }

  function setSelected({ snapshotId, nodeId, values }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    const before = stateOf(element);
    if (element.tagName !== 'SELECT') return { error: 'Target is not a select control' };
    const wanted = new Set(values);
    for (const option of element.options) option.selected = wanted.has(option.value);
    fire(element, ['input', 'change']);
    return { ok: true, docToken, before, after: stateOf(element) };
  }

  function setAlt({ snapshotId, nodeId, alt, present = true }) {
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { error: 'Target no longer exists; observe the page again' };
    if (element.tagName !== 'IMG') return { error: 'Target is not an image' };
    const before = { present: element.hasAttribute('alt'), value: element.getAttribute('alt') ?? '' };
    if (present) element.setAttribute('alt', alt);
    else element.removeAttribute('alt');
    return {
      ok: true,
      docToken,
      before,
      after: { present: element.hasAttribute('alt'), value: element.getAttribute('alt') ?? '' },
    };
  }

  function hashText() {
    const text = (document.body?.innerText ?? '').slice(0, 200000);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
  }

  function stateFor({ snapshotId, nodeId, includeHash = false, fullValue = false }) {
    if (nodeId === visualNodeId) {
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot || !snapshot.nodeIds.has(nodeId)) return { exists: false, docToken };
      return {
        exists: true,
        docToken,
        kind: 'visual-region',
        visible: true,
        disabled: false,
        rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
        appearance: `visual:${docToken}`,
        ...(includeHash ? { textHash: hashText() } : {}),
      };
    }
    const element = elementFor(snapshotId, nodeId);
    if (!element) return { exists: false, docToken };
    return {
      exists: true,
      docToken,
      ...stateOf(element, { fullValue }),
      ...(includeHash ? { textHash: hashText() } : {}),
    };
  }

  // Frame-local areas a pointer path must not cross: password inputs and any
  // embedded frame, which cannot be inspected from this document.
  function interactionMasks() {
    const rects = sensitiveRects();
    for (const element of deepElements()) {
      if (element.tagName !== 'IFRAME' && element.tagName !== 'FRAME') continue;
      if (!visible(element)) continue;
      const rect = rectOf(element);
      if (rect.width < 1 || rect.height < 1) continue;
      rects.push({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height });
    }
    return { rects, docToken, viewport: { width: window.innerWidth, height: window.innerHeight } };
  }

  function composedContains(ancestor, node) {
    let current = node;
    let guard = 0;
    while (current && guard < 10_000) {
      guard += 1;
      if (current === ancestor) return true;
      current = current.parentElement ?? current.getRootNode?.()?.host ?? null;
    }
    return false;
  }

  function hitTest({ snapshotId, nodeId, x, y }) {
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot || !snapshot.nodeIds.has(nodeId)) return { error: 'Observe the page again first' };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'Invalid point' };
    const target = elementFor(snapshotId, nodeId);
    let hit = document.elementFromPoint(x, y);
    let guard = 0;
    while (hit?.shadowRoot && guard < 5) {
      guard += 1;
      const inner = hit.shadowRoot.elementFromPoint?.(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return {
      exists: true,
      inside: Boolean(hit),
      hit: hit ? {
        tag: hit.tagName.toLowerCase(),
        role: roleOf(hit),
        name: nameOf(hit).slice(0, 80),
        isFrame: hit.tagName === 'IFRAME' || hit.tagName === 'FRAME',
        matchesTarget: Boolean(target && composedContains(target, hit)),
      } : null,
    };
  }

  function handle(payload) {
    try {
      switch (payload?.op) {
        case 'observe': return observe(payload);
        case 'read': return readTarget(payload);
        case 'focus': return focusTarget(payload);
        case 'scroll': return scrollPage(payload);
        case 'scrollTo': return scrollToTarget(payload);
        case 'state': return stateFor(payload);
        case 'hitTest': return hitTest(payload);
        case 'sensitive': return { rects: sensitiveRects(), docToken };
        case 'masks': return interactionMasks();
        case 'prepareText': return prepareText(payload);
        case 'finishText': return finishText(payload);
        case 'blurTarget': return blurTarget(payload);
        case 'setValue': return setValue(payload);
        case 'setChecked': return setChecked(payload);
        case 'setSelected': return setSelected(payload);
        case 'setAlt': return setAlt(payload);
        case 'navigate': {
          const element = elementFor(payload.snapshotId, payload.nodeId);
          const href = element && linkOf(element);
          if (!href) return { error: 'Link no longer exists' };
          if (href !== payload.href) return { error: 'The link destination changed; observe the page again' };
          location.assign(href);
          return { ok: true, href };
        }
        default: return { error: 'Unknown page operation' };
      }
    } catch (error) {
      return { error: error?.message ?? 'Page operation failed' };
    }
  }

  globalThis.__accessAssistAgent = { version: 1, docToken, handle };
})();
