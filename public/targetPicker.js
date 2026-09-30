// Active-target picker: which conductor session the voice console drives and
// whose finished turns are announced.
import { el } from './dom.js';

export function installTargetPicker(root, api, { onError = () => {} } = {}) {
  const select = el('select', { 'aria-label': 'Active conductor' });
  const refresh = el('button', { type: 'button', class: 'secondary' }, 'Refresh');
  let current = null;

  function render(sessions) {
    const opts = [el('option', { value: '' }, '— no active conductor —')];
    const ids = new Set();
    for (const s of sessions) {
      ids.add(s.sessionId);
      opts.push(el('option', { value: s.sessionId }, `${s.title} (${s.status})`));
    }
    if (current && !ids.has(current.sessionId)) opts.push(el('option', { value: current.sessionId }, current.title));
    select.replaceChildren(...opts);
    select.value = current ? current.sessionId : '';
  }

  async function load() {
    try {
      const data = await api.getConductors();
      current = data.activeTarget;
      render(data.sessions);
    } catch (e) {
      onError(e);
    }
  }

  select.addEventListener('change', async () => {
    try { await api.setTarget(select.value || null); }
    catch (e) { onError(e); load(); }
  });
  refresh.addEventListener('click', load);

  root.append(el('label', {}, ['Conductor ', select]), refresh);

  return {
    load,
    update(target) {
      current = target;
      const known = [...select.options].some((o) => o.value === (target?.sessionId ?? ''));
      if (known) select.value = target ? target.sessionId : '';
      else load();
    },
  };
}
