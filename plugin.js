// =========================================================================
// TANA SYNC PLUGIN (Background Script)
// =========================================================================

const PLUGIN_VERSION = '1.1.0';
const PLUGIN_BUILD = 17;

let config = {};
let iframeSource = null;
let iframeOrigin = '*';
let lastSyncTime = 0;
let syncMap = {};
let syncIntervalId = null;

// Load config safely from host storage
function loadConfigSync() {
  try {
    const stored = localStorage.getItem('tana_sync_config');
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    return {};
  }
}

function loadSyncMap() {
  try {
    const stored = localStorage.getItem('tana_sync_map');
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    return {};
  }
}

function saveSyncMap(map) {
  try {
    localStorage.setItem('tana_sync_map', JSON.stringify(map));
  } catch (e) {
    console.error('Failed to save sync map', e);
  }
}

// Initial load
config = loadConfigSync();
syncMap = loadSyncMap();

// Listen for messages from the iframe
window.addEventListener('message', (event) => {
  if (event.data && event.data.type) {
    if (!iframeSource) iframeSource = event.source;

    if (event.data.type === 'TANA_GET_CONFIG') {
      if (event.source) {
        iframeSource = event.source;
        (async () => {
          let spTags = [];
          let spProjects = [];
          let hostLogs = [];
          
          try {
            hostLogs.push(`--- Tana Sync Plugin v${PLUGIN_VERSION} (Build ${PLUGIN_BUILD}) ---`);
            if (typeof PluginAPI !== 'undefined') {
              let allKeys = [];
              for (let k in PluginAPI) allKeys.push(k);
              hostLogs.push('PluginAPI is defined. Keys (including proto): ' + allKeys.join(', '));
              let state = null;
              if (PluginAPI.getAppState) {
                hostLogs.push('Calling getAppState...');
                state = await PluginAPI.getAppState();
                hostLogs.push('getAppState succeeded. Keys: ' + Object.keys(state || {}).join(', '));
              } else {
                hostLogs.push('getAppState is missing.');
              }
              
              const projectState = state ? (state.projects || state.project) : null;
              if (PluginAPI.getAllProjects) {
                hostLogs.push('Calling getAllProjects...');
                const rawProjects = await PluginAPI.getAllProjects();
                if (Array.isArray(rawProjects)) {
                  spProjects = rawProjects.map(p => ({ id: p.id, title: p.title }));
                  hostLogs.push(`Loaded ${spProjects.length} projects from getAllProjects.`);
                }
              } else if (projectState && projectState.entities) {
                spProjects = Object.values(projectState.entities).map(p => ({ id: p.id, title: p.title }));
                hostLogs.push(`Loaded ${spProjects.length} projects from state.`);
              } else {
                hostLogs.push('Could not find projects.');
              }
              
              const tagState = state ? (state.tags || state.tag) : null;
              if (PluginAPI.getTags) {
                hostLogs.push('Calling PluginAPI.getTags...');
                const rawTags = await PluginAPI.getTags();
                if (Array.isArray(rawTags)) {
                  spTags = rawTags.map(t => ({ id: t.id, title: t.title }));
                  hostLogs.push(`Loaded ${spTags.length} tags from PluginAPI.getTags.`);
                }
              } else if (PluginAPI.getAllTags) {
                hostLogs.push('Calling PluginAPI.getAllTags...');
                const rawTags = await PluginAPI.getAllTags();
                if (Array.isArray(rawTags)) {
                  spTags = rawTags.map(t => ({ id: t.id, title: t.title }));
                  hostLogs.push(`Loaded ${spTags.length} tags from PluginAPI.getAllTags.`);
                }
              } else if (tagState && tagState.entities) {
                spTags = Object.values(tagState.entities).map(t => ({ id: t.id, title: t.title }));
                hostLogs.push(`Loaded ${spTags.length} tags from state.`);
              } else if (Array.isArray(tagState)) {
                spTags = tagState.map(t => ({ id: t.id, title: t.title }));
                hostLogs.push(`Loaded ${spTags.length} tags from state array.`);
              } else {
                hostLogs.push('Could not find tags. tagState keys: ' + (tagState ? Object.keys(tagState).join(', ') : 'null'));
              }
            } else {
              hostLogs.push('PluginAPI is UNDEFINED.');
            }
          } catch (e) {
            hostLogs.push('Error during SP data fetch: ' + e.message);
            console.error("Failed to fetch SP data", e);
          }

          event.source.postMessage({ 
            type: 'TANA_CONFIG_DATA', 
            config: config,
            spTags: spTags,
            spProjects: spProjects,
            hostLogs: hostLogs
          }, '*');
        })();
      }
    } else if (event.data.type === 'TANA_SAVE_CONFIG') {
      config = event.data.config || {};
      try {
        localStorage.setItem('tana_sync_config', JSON.stringify(config));
      } catch (e) {
        console.error('Failed to save config to localStorage', e);
      }
      const rCount = (config.routingRules && Array.isArray(config.routingRules)) ? config.routingRules.length : 0;
      if (iframeSource) {
        iframeSource.postMessage({ type: 'TANA_SYNC_RESULT', message: `Config saved! (${rCount} rules active)`, isError: false }, '*');
        iframeSource.postMessage({ type: 'TANA_DEBUG_LOG', message: `[CONFIG SAVED] Background worker stored ${rCount} routing rule(s): ${JSON.stringify(config.routingRules || [])}` }, '*');
      }
      // Restart loop with new interval
      if (syncIntervalId) clearInterval(syncIntervalId);
      syncIntervalId = setInterval(runSync, (config.syncInterval || 15) * 60000);
    } else if (event.data.type === 'TANA_MANUAL_SYNC') {
      if (iframeSource) {
        iframeSource.postMessage({ type: 'TANA_SYNC_RESULT', message: 'Syncing now...', isError: false }, '*');
      }
      runSync();
    } else if (event.data.type === 'TANA_SEARCH_NODES') {
      const query = (event.data.query || '').trim();
      const ruleIndex = event.data.ruleIndex;
      const targetSource = event.source || iframeSource;
      (async () => {
        let results = [];
        try {
          if (config.apiUrl && config.apiToken && query) {
            const headers = {
              'Authorization': config.apiToken.startsWith('Bearer ') ? config.apiToken : `Bearer ${config.apiToken}`,
              'Content-Type': 'application/json'
            };

            // Check if user pasted a Tana URL or direct node ID
            let directNodeId = null;
            const urlMatch = query.match(/[?&]nodeid=([a-zA-Z0-9_-]+)/i);
            if (urlMatch) {
              directNodeId = urlMatch[1];
            } else if (/^[a-zA-Z0-9_-]{10,25}$/.test(query)) {
              directNodeId = query;
            }

            if (directNodeId) {
              try {
                const nodeRes = await fetch(`${config.apiUrl}/nodes/${directNodeId}`, { headers });
                if (nodeRes.ok) {
                  const nodeData = await nodeRes.json();
                  if (nodeData && nodeData.name) {
                    results.push({
                      id: directNodeId,
                      name: cleanHtmlTags(nodeData.name),
                      breadcrumb: (nodeData.breadcrumb || []).map(cleanHtmlTags)
                    });
                  }
                }
              } catch (e) {}
            }

            if (results.length === 0) {
              const searchUrl = new URL(`${config.apiUrl}/nodes/search`);
              searchUrl.searchParams.append('limit', '10');
              searchUrl.searchParams.append('query[textContains]', query);
              const res = await fetch(searchUrl.toString(), { headers });
              if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                  results = data.slice(0, 10).map(n => ({
                    id: n.id,
                    name: cleanHtmlTags(n.name || ''),
                    breadcrumb: (n.breadcrumb || []).map(cleanHtmlTags)
                  })).filter(n => n.name);
                }
              }
            }
          }
        } catch (err) {
          console.error('Error searching Tana nodes:', err);
        }

        if (targetSource) {
          targetSource.postMessage({
            type: 'TANA_SEARCH_NODES_RESULT',
            query: query,
            ruleIndex: ruleIndex,
            results: results
          }, '*');
        }
      })();
    }
  }
});

// --- ID Encoding Helpers ---
const ZW_PREFIX = '\u200D\u200D\u200D';
const ZW_SUFFIX = '\u200D\u200D\u200D';

function encodeId(idStr) {
  return Array.from(idStr).map(c => 
    c.charCodeAt(0).toString(2).padStart(8, '0').split('').map(b => b === '1' ? '\u200C' : '\u200B').join('')
  ).join('');
}

function decodeId(encodedStr) {
  const binary = Array.from(encodedStr).map(c => c === '\u200C' ? '1' : '0').join('');
  let str = '';
  for (let i = 0; i < binary.length; i += 8) {
    str += String.fromCharCode(parseInt(binary.slice(i, i+8), 2));
  }
  return str;
}

function embedId(title, idStr) {
  return title + ZW_PREFIX + encodeId(idStr) + ZW_SUFFIX;
}

function extractId(title) {
  if (!title) return null;
  const match = title.match(new RegExp(ZW_PREFIX + '([\\u200B\\u200C]+)' + ZW_SUFFIX));
  if (match) return decodeId(match[1]);
  return null;
}

function cleanHtmlTags(text) {
  if (!text) return '';
  if (typeof text === 'object' && text.name) text = text.name;
  if (typeof text !== 'string') text = String(text);
  return text.replace(/<[^>]*>/g, '').trim();
}

function formatBreadcrumbPath(breadcrumb) {
  if (!Array.isArray(breadcrumb) || breadcrumb.length === 0) return '';
  const filtered = breadcrumb
    .map(b => cleanHtmlTags(b).trim())
    .filter(b => {
      if (!b) return false;
      const lower = b.toLowerCase();
      if (lower === 'rahul') return false;
      if (lower === 'daily notes') return false;
      if (lower === 'schema') return false;
      if (/^\d{4}$/.test(b)) return false; // 4-digit year like 2025, 2026
      if (/^week\s+\d+$/i.test(b)) return false; // Week 01, Week 31, etc.
      return true;
    });
  return filtered.join(' > ');
}

function parseTanaDate(dateStr) {
  if (!dateStr) return null;
  dateStr = dateStr.replace(/<!--.*?-->/g, '').trim();
  
  const monthRegex = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
  if (!monthRegex.test(dateStr)) {
    return null;
  }
  
  if (!/\d{4}/.test(dateStr)) {
    dateStr += `, ${new Date().getFullYear()}`;
  }
  
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    d.setUTCHours(12, 0, 0, 0);
    return d.toISOString();
  }
  return null;
}

function evaluateTaskRouting(node, config) {
  const rules = config.routingRules || [];
  const bc = node.breadcrumb || [];
  const nodeTags = node.tags || [];
  const nodeTagIds = node.tagIds || [];
  const nodeName = cleanHtmlTags(node.name || '').trim();

  let matchedRule = null;

  for (const rule of rules) {
    if (!rule.pattern || !rule.pattern.trim()) continue;
    const pattern = cleanHtmlTags(rule.pattern).replace(/^['"`]|['"`]$/g, '').trim().toLowerCase();
    if (!pattern) continue;

    const mode = rule.matchMode || 'contains';
    const type = rule.matchType || 'ancestor';

    let isMatch = false;

    if (type === 'ancestor') {
      isMatch = bc.some(b => {
        const cleanB = cleanHtmlTags(b).replace(/^['"`]|['"`]$/g, '').trim().toLowerCase();
        return mode === 'exact' ? cleanB === pattern : cleanB.includes(pattern);
      });
    } else if (type === 'supertag') {
      isMatch = nodeTags.some(t => {
        const cleanT = cleanHtmlTags(t.name || '').replace(/^['"`]|['"`]$/g, '').trim().toLowerCase();
        return mode === 'exact' ? cleanT === pattern : cleanT.includes(pattern);
      }) || nodeTagIds.some(tid => tid.toLowerCase() === pattern);
    } else if (type === 'title') {
      const lowerName = nodeName.toLowerCase();
      isMatch = mode === 'exact' ? lowerName === pattern : lowerName.includes(pattern);
    }

    if (isMatch) {
      matchedRule = rule;
      break;
    }
  }

  // Determine Project
  let effectiveProjectId = null;
  if (matchedRule && matchedRule.targetProjectId) {
    effectiveProjectId = matchedRule.targetProjectId;
  } else if (config.targetSpProjectId) {
    effectiveProjectId = config.targetSpProjectId;
  }

  // Determine Tags
  const tagSet = new Set();
  const defaultTag = config.targetSpTagId || null;
  const keepDefault = config.keepDefaultTag !== false;

  if (matchedRule && matchedRule.targetTagId) {
    tagSet.add(matchedRule.targetTagId);
    if (keepDefault && defaultTag) {
      tagSet.add(defaultTag);
    }
  } else if (defaultTag) {
    tagSet.add(defaultTag);
  }

  return {
    projectId: effectiveProjectId,
    tagIds: Array.from(tagSet),
    matchedRule: matchedRule
  };
}

async function runSync() {
  config = loadConfigSync();
  if (iframeSource) {
    const rCount = (config.routingRules && Array.isArray(config.routingRules)) ? config.routingRules.length : 0;
    iframeSource.postMessage({ 
      type: 'TANA_DEBUG_LOG', 
      message: `--- Sync Started (Worker v${PLUGIN_VERSION} Build ${PLUGIN_BUILD}) ---\nLoaded ${rCount} routing rule(s): ${JSON.stringify(config.routingRules || [])}` 
    }, '*');
  }

  if (!config.apiUrl || !config.apiToken) {
    if (iframeSource) {
      iframeSource.postMessage({ type: 'TANA_SYNC_RESULT', message: 'Missing API config', isError: true }, '*');
    }
    return;
  }

  try {
    const spTasks = await PluginAPI.getTasks();
    
    const headers = {
      'Authorization': config.apiToken.startsWith('Bearer ') ? config.apiToken : `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json'
    };

    let importedCount = 0;
    let completedCount = 0;

    // 1. Sync SP completions back to Tana
    for (const spTask of spTasks) {
      if (spTask.isDone) {
        const refId = extractId(spTask.title);
        if (refId && (!syncMap[refId] || !syncMap[refId].tanaDone)) {
          // Mark done in Tana
          try {
            const res = await fetch(`${config.apiUrl}/nodes/${refId}/done`, {
              method: 'POST',
              headers: headers,
              body: JSON.stringify({ done: true })
            });
            if (res.ok) {
              syncMap[refId] = syncMap[refId] || {};
              syncMap[refId].tanaDone = true;
            }
          } catch (e) {
            console.error(`Error completing Tana node ${refId}:`, e);
          }
        }
      }
    }

    // 2. Query Tana for Tasks
    const searchUrl = new URL(`${config.apiUrl}/nodes/search`);
    searchUrl.searchParams.append('limit', '1000');
    
    let orIndex = 0;
    
    // Add physical checkboxes if selected (or if not explicitly set to false, for backwards compatibility)
    if (config.includeCheckboxes !== false) {
      searchUrl.searchParams.append(`query[or][${orIndex++}][is]`, 'todo');
    }
    
    if (config.taskTagId) {
      const tagIds = config.taskTagId.split(',').map(s => s.trim()).filter(s => s);
      for (const tId of tagIds) {
        searchUrl.searchParams.append(`query[or][${orIndex++}][hasType]`, tId);
      }
    }
    
    // Fallback if neither is configured (prevent fetching entire DB)
    if (orIndex === 0) {
      searchUrl.searchParams.append('query[is]', 'todo');
    }
    
    // Aggressive cache busting
    searchUrl.searchParams.append('_t', Date.now());

    const searchRes = await fetch(searchUrl.toString(), { 
      headers,
      cache: 'no-store'
    });
    if (!searchRes.ok) {
      throw new Error(`Tana API error: ${searchRes.statusText}`);
    }
    
    const nodes = await searchRes.json();
    if (iframeSource) iframeSource.postMessage({ type: 'TANA_DEBUG_LOG', message: `Search returned ${nodes.length} nodes.` }, '*');
    
    for (const node of nodes) {
      const refId = node.id;
      const rawName = node.name || '';
      const name = cleanHtmlTags(rawName);
      
      const isTest = name.toLowerCase().includes('test');
      if (isTest && iframeSource) {
        iframeSource.postMessage({ type: 'TANA_DEBUG_LOG', message: `Found test node: "${name}". Trash=${node.inTrash}, BC=${JSON.stringify(node.breadcrumb || [])}` }, '*');
      }
      
      if (node.inTrash || !name) continue;
      
      const bc = node.breadcrumb || [];
      // Skip supertag definitions which live inside a "schema" parent
      if (bc.some(b => b.toLowerCase() === 'schema')) continue;
      
      const ownerName = bc.length > 0 ? cleanHtmlTags(bc[bc.length - 1]) : '';
      const finalTitle = ownerName ? `${name} (${ownerName})` : name;
      
      let tanaCompleted = false;
      let isTodo = false;
      let markdown = '';
      
      try {
        const nodeRes = await fetch(`${config.apiUrl}/nodes/${refId}`, { headers });
        if (nodeRes.ok) {
          const nodeData = await nodeRes.json();
          markdown = nodeData.markdown || '';
          tanaCompleted = markdown.includes('- [X]') || markdown.includes('- [x]');
          isTodo = true; // Any node returned by this search is a task by definition
          
          if (isTest && iframeSource) {
            iframeSource.postMessage({ type: 'TANA_DEBUG_LOG', message: `Test node markdown read. Includes [X]? ${tanaCompleted}` }, '*');
            iframeSource.postMessage({ type: 'TANA_DEBUG_LOG', message: `Raw Markdown: ${markdown.substring(0, 100)}...` }, '*');
          }
        }
      } catch (e) {
        console.error(`Error reading Tana node ${refId}:`, e);
        continue;
      }
      
      // 1. Due Date (Deadline)
      let tanaDueDateIso = null;
      const dueFieldName = (config.dueDateField && config.dueDateField.trim()) ? config.dueDateField.trim() : 'Due date';
      const escapedDueField = dueFieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const dueMatch = markdown.match(new RegExp(`\\*\\*(?:${escapedDueField})\\*\\*:\\s*(.*?)(\\n|$)`, 'i'));
      if (dueMatch) {
        tanaDueDateIso = parseTanaDate(dueMatch[1]);
      }

      // 2. Planned Date (Scheduled)
      let tanaSchedDateIso = null;
      
      // Step A: Custom planned date field if configured
      if (config.plannedDateField && config.plannedDateField.trim()) {
        const plannedFieldName = config.plannedDateField.trim();
        const escapedPlannedField = plannedFieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const schedMatch = markdown.match(new RegExp(`\\*\\*(?:${escapedPlannedField})\\*\\*:\\s*(.*?)(\\n|$)`, 'i'));
        if (schedMatch) {
          tanaSchedDateIso = parseTanaDate(schedMatch[1]);
        }
      }

      // Step B: Check immediate parent node
      if (!tanaSchedDateIso && bc.length > 0) {
        const parentName = cleanHtmlTags(bc[bc.length - 1]);
        if (parentName.toLowerCase().startsWith('today')) {
          const d = new Date();
          d.setUTCHours(12, 0, 0, 0);
          tanaSchedDateIso = d.toISOString();
        } else {
          const cleanParentName = parentName.replace(/(\d+)(st|nd|rd|th)/, '$1');
          tanaSchedDateIso = parseTanaDate(cleanParentName);
        }
      }

      // Step C: Auto-plan from Daily Note / Day of Creation if enabled
      if (!tanaSchedDateIso && bc.length > 0 && config.autoPlanFromDay !== false) {
        for (let i = bc.length - 1; i >= 0; i--) {
          const bName = cleanHtmlTags(bc[i]);
          if (bName.toLowerCase().startsWith('today')) {
            const d = new Date();
            d.setUTCHours(12, 0, 0, 0);
            tanaSchedDateIso = d.toISOString();
            break;
          }
          const cleanName = bName.replace(/(\d+)(st|nd|rd|th)/, '$1');
          const parsed = parseTanaDate(cleanName);
          if (parsed) {
            tanaSchedDateIso = parsed;
            break;
          }
        }
      }

      const spTask = spTasks.find(t => extractId(t.title) === refId);

      if (!spTask) {
        // New task to import
        if (isTodo && !tanaCompleted) {
          
          const locationPath = formatBreadcrumbPath(bc);
          let fullNotes = '';
          if (locationPath) {
            fullNotes += `**Location:** ${locationPath}\n\n`;
          }
          fullNotes += `[Open in Tana](https://app.tana.inc/?nodeid=${refId})\n\n---\n**Tana Content:**\n\n${markdown}`;
          
          const routing = evaluateTaskRouting(node, config);
          
          const payload = {
            title: embedId(finalTitle, refId),
            notes: fullNotes,
            tagIds: routing.tagIds || [],
          };
          if (routing.projectId) {
            payload.projectId = routing.projectId;
          }
          
          if (tanaSchedDateIso) {
            payload.dueDay = tanaSchedDateIso.substring(0, 10);
            payload.plannedAt = new Date(tanaSchedDateIso).getTime();
          }
          
          if (iframeSource) {
            if (routing.matchedRule) {
              iframeSource.postMessage({ 
                type: 'TANA_DEBUG_LOG', 
                message: `[RULE MATCH] "${finalTitle}": matched [${routing.matchedRule.pattern}] -> Project: ${routing.projectId || 'Default'}, Tags: [${routing.tagIds.join(', ')}]` 
              }, '*');
            } else {
              const rCount = (config.routingRules && Array.isArray(config.routingRules)) ? config.routingRules.length : 0;
              iframeSource.postMessage({ 
                type: 'TANA_DEBUG_LOG', 
                message: `[NO RULE MATCH] "${finalTitle}": fallback -> Project: ${routing.projectId || 'Default'}, Tags: [${routing.tagIds.join(', ')}]. Breadcrumbs: ${JSON.stringify(bc)}. Active rules (${rCount}): ${JSON.stringify(config.routingRules || [])}` 
              }, '*');
            }
          }
          
          if (isTest && iframeSource) {
            iframeSource.postMessage({ type: 'TANA_DEBUG_LOG', message: `Adding new task to SP: ${finalTitle} with dueDay=${payload.dueDay}, plannedAt=${payload.plannedAt}, deadline=${tanaDueDateIso}` }, '*');
          }
          
          const res = await PluginAPI.addTask(payload);
          
          let newTaskId = (typeof res === 'string') ? res : (res && res.id ? res.id : null);
          if (!newTaskId) {
            const freshTasks = await PluginAPI.getTasks();
            const created = freshTasks.find(t => extractId(t.title) === refId);
            if (created) newTaskId = created.id;
          }
          if (newTaskId) {
            const postUpdates = {};
            if (tanaDueDateIso) {
              postUpdates.deadlineDay = tanaDueDateIso.substring(0, 10);
            }
            if (routing.projectId) {
              postUpdates.projectId = routing.projectId;
            }
            if (routing.tagIds && routing.tagIds.length > 0) {
              postUpdates.tagIds = routing.tagIds;
            }
            if (Object.keys(postUpdates).length > 0) {
              await PluginAPI.updateTask(newTaskId, postUpdates);
            }
          }
          
          syncMap[refId] = {
            tanaDone: false,
            lastTanaSchedIso: tanaSchedDateIso || null,
            lastTanaDueIso: tanaDueDateIso || null,
            syncedDueDay: payload.dueDay || null,
            syncedPlannedAt: payload.plannedAt || null,
            syncedDeadlineDay: (tanaDueDateIso ? tanaDueDateIso.substring(0, 10) : null)
          };
          
          importedCount++;
        }
      } else {
        // Existing task mapped
        let updates = {};
        syncMap[refId] = syncMap[refId] || {};
        const entry = syncMap[refId];
        
        if (tanaCompleted && !spTask.isDone) {
          updates.isDone = true;
          entry.tanaDone = true;
          completedCount++;
        }
        
        // --- Planned / Scheduled Date Preservation ---
        const targetDueDay = tanaSchedDateIso ? tanaSchedDateIso.substring(0, 10) : null;
        const targetPlannedAt = tanaSchedDateIso ? new Date(tanaSchedDateIso).getTime() : null;

        if (entry.lastTanaSchedIso === undefined) {
          // First time seeing this task with date tracking:
          // Adopt whatever SP currently has to avoid reverting user changes!
          entry.lastTanaSchedIso = tanaSchedDateIso || null;
          entry.syncedDueDay = spTask.dueDay || null;
          entry.syncedPlannedAt = spTask.plannedAt || null;
        } else if (entry.lastTanaSchedIso !== (tanaSchedDateIso || null)) {
          // Tana's scheduled date was actively changed in Tana!
          if (targetDueDay) {
            updates.dueDay = targetDueDay;
            updates.plannedAt = targetPlannedAt;
          } else {
            updates.dueDay = null;
            updates.plannedAt = null;
          }
          entry.lastTanaSchedIso = tanaSchedDateIso || null;
          entry.syncedDueDay = targetDueDay;
          entry.syncedPlannedAt = targetPlannedAt;
        } else {
          // Tana did NOT change.
          // If the user changed the date in SP, preserve SP's new date!
          entry.syncedDueDay = spTask.dueDay || null;
          entry.syncedPlannedAt = spTask.plannedAt || null;
        }

        // --- Due Date (Deadline) Preservation ---
        const targetDeadlineDay = tanaDueDateIso ? tanaDueDateIso.substring(0, 10) : null;

        if (entry.lastTanaDueIso === undefined) {
          // First time seeing this task with date tracking:
          entry.lastTanaDueIso = tanaDueDateIso || null;
          entry.syncedDeadlineDay = spTask.deadlineDay || null;
        } else if (entry.lastTanaDueIso !== (tanaDueDateIso || null)) {
          // Tana's deadline was actively changed in Tana!
          updates.deadlineDay = targetDeadlineDay;
          entry.lastTanaDueIso = tanaDueDateIso || null;
          entry.syncedDeadlineDay = targetDeadlineDay;
        } else {
          // Tana did NOT change.
          // Preserve SP's deadline even if user changed it in SP!
          entry.syncedDeadlineDay = spTask.deadlineDay || null;
        }

        const locationPath = formatBreadcrumbPath(bc);
        let fullNotes = '';
        if (locationPath) {
          fullNotes += `**Location:** ${locationPath}\n\n`;
        }
        fullNotes += `[Open in Tana](https://app.tana.inc/?nodeid=${refId})\n\n---\n**Tana Content:**\n\n${markdown}`;
        updates.notes = fullNotes;

        // Re-apply routing rules to open tasks if enabled
        if (!spTask.isDone && config.updateExistingTasks !== false) {
          const routing = evaluateTaskRouting(node, config);
          if (routing.matchedRule) {
            if (routing.projectId && spTask.projectId !== routing.projectId) {
              updates.projectId = routing.projectId;
              if (iframeSource) {
                iframeSource.postMessage({ 
                  type: 'TANA_DEBUG_LOG', 
                  message: `Re-routing existing task "${finalTitle}" to Project: ${routing.projectId}` 
                }, '*');
              }
            }
            if (routing.tagIds && routing.tagIds.length > 0) {
              const currentTags = spTask.tagIds || [];
              const hasAllTags = routing.tagIds.every(t => currentTags.includes(t));
              if (!hasAllTags) {
                const merged = Array.from(new Set([...currentTags, ...routing.tagIds]));
                updates.tagIds = merged;
                if (iframeSource) {
                  iframeSource.postMessage({ 
                    type: 'TANA_DEBUG_LOG', 
                    message: `Re-routing existing task "${finalTitle}" tags to: [${merged.join(', ')}]` 
                  }, '*');
                }
              }
            }
          }
        }

        if (Object.keys(updates).length > 0) {
          await PluginAPI.updateTask(spTask.id, updates);
        }
      }
    }
    
    saveSyncMap(syncMap);
    
    if (iframeSource) {
      iframeSource.postMessage({ 
        type: 'TANA_SYNC_RESULT', 
        message: `Sync complete: ${importedCount} imported, ${completedCount} marked complete.`,
        isError: false
      }, '*');
    }
  } catch (e) {
    console.error('Tana Sync Error:', e);
    if (iframeSource) {
      iframeSource.postMessage({ 
        type: 'TANA_SYNC_RESULT', 
        message: `Sync failed: ${e.message}`,
        isError: true
      }, '*');
    }
  }
}

// Set up polling interval
syncIntervalId = setInterval(() => {
  const currentConfig = loadConfigSync();
  const freqMinutes = currentConfig.syncInterval || 5;
  const freqMs = freqMinutes * 60 * 1000;
  const now = Date.now();

  if (now - lastSyncTime >= freqMs) {
    lastSyncTime = now;
    runSync();
  }
}, 30000); // Check every 30 seconds

// Provide a hook for task completion in SP so it is responsive
PluginAPI.registerHook(PluginAPI.Hooks.TASK_COMPLETE, async (payload) => {
  const task = payload.task;
  if (!task) return;
  
  const refId = extractId(task.title);
  if (refId) {
    try {
      const headers = {
        'Authorization': config.apiToken.startsWith('Bearer ') ? config.apiToken : `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json'
      };
      const res = await fetch(`${config.apiUrl}/nodes/${refId}/done`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ done: true })
      });
      if (res.ok) {
        syncMap[refId] = syncMap[refId] || {};
        syncMap[refId].tanaDone = true;
        saveSyncMap(syncMap);
      }
    } catch (e) {
      console.error(`Error completing Tana node ${refId} on hook:`, e);
    }
  }
});

console.log('Tana Sync plugin loaded!');
