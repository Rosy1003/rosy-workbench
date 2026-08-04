// Cloudflare Pages Advanced Mode - Single Worker
// Handles all /api/* routes; falls back to static assets for everything else

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

// ===== Sync helpers =====
function generateSyncCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = '';
  for (var i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getDeviceName(ua) {
  var isMobile = /Mobile|Android|iPhone|iPad/.test(ua);
  var browser = /Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return (isMobile ? 'Mobile-' : 'PC-') + browser;
}

// ===== Teacher plan helpers =====
const TP_SOURCE_URL = 'https://toashore.cn/public/apps/calendar/online/index.html?qq_aio_chat_type=2';
const TP_API_URL = 'https://toashore.cn/public/apps/calendar/online/api.php';

function tpFormatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ===== Main Worker =====
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // ===== /api/ping =====
    if (path === '/api/ping') {
      return jsonResponse(200, { ok: true, message: 'pong', time: new Date().toISOString() });
    }

    // ===== /api/sync =====
    if (path === '/api/sync') {
      // GET: pull data
      if (request.method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) {
          return jsonResponse(400, { ok: false, error: '缺少同步码' });
        }
        if (!env || !env.ROSY_SYNC) {
          return jsonResponse(500, { ok: false, error: 'KV 未绑定，请在 Cloudflare Dashboard 中绑定 ROSY_SYNC KV namespace' });
        }
        try {
          var key = 'sync:' + code;
          var raw = await env.ROSY_SYNC.get(key);
          if (!raw) {
            return jsonResponse(404, { ok: false, error: '同步码不存在或已过期' });
          }
          var record = JSON.parse(raw);
          return jsonResponse(200, {
            ok: true,
            data: record.data,
            updatedAt: record.updatedAt,
            deviceName: record.deviceName || ''
          });
        } catch (e) {
          return jsonResponse(500, { ok: false, error: '读取失败: ' + e.message });
        }
      }

      // POST: register / push / check
      if (request.method === 'POST') {
        if (!env || !env.ROSY_SYNC) {
          return jsonResponse(500, { ok: false, error: 'KV 未绑定，请在 Cloudflare Dashboard 中绑定 ROSY_SYNC KV namespace' });
        }
        var body;
        try {
          body = await request.json();
        } catch (e) {
          return jsonResponse(400, { ok: false, error: '请求体格式错误' });
        }
        var action = body.action;

        // register
        if (action === 'register') {
          var newCode;
          for (var i = 0; i < 10; i++) {
            newCode = generateSyncCode();
            var existing = await env.ROSY_SYNC.get('sync:' + newCode);
            if (!existing) break;
          }
          if (!newCode) {
            return jsonResponse(500, { ok: false, error: '生成同步码失败' });
          }
          var now = new Date().toISOString();
          var newRecord = {
            data: null,
            createdAt: now,
            updatedAt: now,
            deviceName: body.deviceName || '初始设备'
          };
          await env.ROSY_SYNC.put('sync:' + newCode, JSON.stringify(newRecord));
          return jsonResponse(200, { ok: true, syncCode: newCode, message: '同步码已生成' });
        }

        // push
        if (action === 'push') {
          var pushCode = body.syncCode;
          var pushData = body.data;
          if (!pushCode || !pushData) {
            return jsonResponse(400, { ok: false, error: '缺少同步码或数据' });
          }
          var pushKey = 'sync:' + pushCode;
          var pushExisting = await env.ROSY_SYNC.get(pushKey);
          if (!pushExisting) {
            return jsonResponse(404, { ok: false, error: '同步码不存在' });
          }
          var pushNow = new Date().toISOString();
          var oldRecord = JSON.parse(pushExisting);
          var pushRecord = {
            data: pushData,
            createdAt: oldRecord.createdAt,
            updatedAt: pushNow,
            deviceName: body.deviceName || '未知设备'
          };
          await env.ROSY_SYNC.put(pushKey, JSON.stringify(pushRecord));
          return jsonResponse(200, { ok: true, updatedAt: pushNow, message: '数据已同步' });
        }

        // check
        if (action === 'check') {
          var checkCode = body.syncCode;
          if (!checkCode) {
            return jsonResponse(400, { ok: false, error: '缺少同步码' });
          }
          var checkExisting = await env.ROSY_SYNC.get('sync:' + checkCode);
          if (!checkExisting) {
            return jsonResponse(404, { ok: false, error: '同步码不存在' });
          }
          var checkRecord = JSON.parse(checkExisting);
          return jsonResponse(200, {
            ok: true,
            hasData: !!checkRecord.data,
            updatedAt: checkRecord.updatedAt,
            createdAt: checkRecord.createdAt
          });
        }

        return jsonResponse(400, { ok: false, error: '未知操作' });
      }
    }

    // ===== /api/teacher-plan =====
    if (path === '/api/teacher-plan') {
      const date = url.searchParams.get('date') || tpFormatDate(new Date());
      const apiUrl = `${TP_API_URL}?action=daily&date=${date}`;

      try {
        // Add 10s timeout to upstream fetch
        const fetchController = new AbortController();
        const fetchTimeout = setTimeout(() => fetchController.abort(), 10000);
        const resp = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': TP_SOURCE_URL,
            'X-Requested-With': 'XMLHttpRequest',
            'X-Calendar-Frontend': '1',
          },
          signal: fetchController.signal,
        });
        clearTimeout(fetchTimeout);

        if (!resp.ok) {
          return jsonResponse(502, {
            ok: false,
            error: `上游返回 ${resp.status}`,
            hint: '未能读取当天每日计划，请稍后重试。',
            syncTime: new Date().toLocaleString('zh-CN'),
          });
        }

        const rawData = await resp.json();

        if (!rawData.success && !rawData.dailyPlans) {
          return jsonResponse(200, {
            ok: false,
            error: rawData.message || '接口返回失败',
            syncTime: new Date().toLocaleString('zh-CN'),
          });
        }

        const plans = rawData.dailyPlans || [];
        if (!plans.length) {
          return jsonResponse(200, {
            ok: false,
            error: rawData.message || '当天计划未更新',
            syncTime: new Date().toLocaleString('zh-CN'),
          });
        }

        const blocks = [];
        const firstTitle = plans[0].title || '当天每日计划';
        for (const plan of plans) {
          const parts = [];
          if (plan.startText) parts.push(plan.startText);
          if (plan.title) parts.push(plan.title);
          if (plan.description) parts.push(plan.description);
          blocks.push(parts.join('\n\n').trim());
        }

        const pageDate = `${rawData.selectedDateText || ''} · ${rawData.selectedWeekday || ''}`.trim().replace(/^·\s*|·\s*$/g, '');

        return jsonResponse(200, {
          ok: true,
          title: firstTitle,
          content: blocks.join('\n\n'),
          pageDate: pageDate,
          syncTime: new Date().toLocaleString('zh-CN'),
          source: TP_SOURCE_URL,
        });
      } catch (err) {
        return jsonResponse(502, {
          ok: false,
          error: err.message || '网络请求失败',
          hint: '请稍后重试或手动粘贴。',
          syncTime: new Date().toLocaleString('zh-CN'),
        });
      }
    }

    // ===== Fallback: serve static assets =====
    return env.ASSETS.fetch(request);
  }
};
