/* ITSM adapter for the workspace backup module (per-tool; the shared module is workspace-backup.js).
 * Says which of the tool's saved items belong to the workspace and how to summarise / check them. */
var WB_ADAPTER = (function () {
  'use strict';
  function parseJson(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }
  function listLen(entries, key) { var v = entries[key] !== undefined ? parseJson(entries[key]) : undefined; return Array.isArray(v) ? v.length : 0; }
  function isSession(k) { return k === 'itsm_session' || k.indexOf('itsm_session_') === 0; }
  return {
    tool: 'itsm',
    toolName: 'ITSM Workflow Intelligence Tool',
    version: 'v25',
    fileStem: 'itsm',
    prefix: ['itsm_'],
    // downloaded-guidance cache and "seen" / first-run flags are not user work; they are rebuilt by the tool
    exclude: /^(itsm_content_cache|itsm_content_seen_v1|itsm_version_seen_v1|itsm_welcomed|itsm_onboarded_v11|itsm_quickstart_done)$/,
    extraExcludedNote: 'first-run flags',

    summarise: function (entries) {
      var keys = Object.keys(entries), saved = keys.filter(function (k) { return k.indexOf('itsm_session_') === 0; }).length;
      var other = keys.filter(function (k) { return !isSession(k) && ['itsm_timeline', 'itsm_decisions', 'itsm_actions'].indexOf(k) < 0; }).length;
      return [['Saved sessions', saved], ['Incident being edited', entries.itsm_session !== undefined ? 1 : 0], ['Timeline events', listLen(entries, 'itsm_timeline')],
        ['Decision log entries', listLen(entries, 'itsm_decisions')], ['Action items', listLen(entries, 'itsm_actions')], ['Other saved settings', other]];
    },

    hasWork: function (entries) {
      return Object.keys(entries).some(function (k) { return isSession(k) && entries[k] && entries[k] !== '{}'; }) ||
        listLen(entries, 'itsm_timeline') > 0 || listLen(entries, 'itsm_decisions') > 0 || listLen(entries, 'itsm_actions') > 0;
    },

    /** A readable Markdown summary of the data (for pasting into a wiki page). Not a backup. */
    readable: function (entries) {
      function cell(v) { return String(v == null ? '' : v).split('|').join(String.fromCharCode(166)).split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(10)).join(' ').trim(); }
      var keys = Object.keys(entries).filter(function (k) { return k.indexOf('itsm_session_') === 0; }).sort();
      var out = ['**Saved sessions:** ' + keys.length + '  |  **Timeline events:** ' + listLen(entries, 'itsm_timeline') + '  |  **Decision log entries:** ' + listLen(entries, 'itsm_decisions') + '  |  **Action items:** ' + listLen(entries, 'itsm_actions'), '', '## Saved sessions', '', '| Session | Severity | Service / summary | Saved |', '|---|---|---|---|'];
      keys.forEach(function (k) {
        var d = parseJson(entries[k]) || {}, when = d.savedAt ? new Date(d.savedAt).toISOString().slice(0, 16).replace('T', ' ') : '';
        out.push('| ' + [cell(k.slice('itsm_session_'.length)), cell(d.sev), cell(d.t1_service || d.i_shortdesc), when].join(' | ') + ' |');
      });
      if (!keys.length) out.push('| _none_ | | | |');
      return out.join(String.fromCharCode(10));
    },

    /** '' when fine, otherwise a plain sentence saying what is wrong. Values that look like JSON must be readable JSON; saved sessions must be objects. */
    validateValue: function (key, value) {
      var looksJson = /^\s*[\[{]/.test(value);
      if (looksJson && parseJson(value) === undefined) return 'A saved item in the file ("' + key.slice(0, 40) + '") is not readable.';
      if (isSession(key)) { var o = parseJson(value); if (!o || typeof o !== 'object' || Array.isArray(o)) return 'The saved session "' + key.slice(0, 40) + '" in the file is not readable.'; }
      if (['itsm_timeline', 'itsm_decisions', 'itsm_actions'].indexOf(key) >= 0 && !Array.isArray(parseJson(value))) return 'The saved list "' + key + '" in the file is not a list.';
      return '';
    }
  };
})();
if (typeof module === 'object' && module.exports) module.exports = WB_ADAPTER;
