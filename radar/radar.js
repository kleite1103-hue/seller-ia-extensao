/**
 * Radar Shopee · o mapeador
 *
 * Nao analisa nada. Escuta tudo que a Shopee carrega enquanto voce
 * navega, agrupa por rota, e mostra o que cada uma devolve — quais
 * campos, que tipo, um exemplo real.
 *
 * A ideia: navegar pelas telas que ainda nao conhecemos e descobrir
 * o que existe, antes de decidir o que construir.
 */
(function () {
  'use strict';

  var VERSAO = '1.0.0';
  var MAX_ROTAS = 400;
  var MAX_AMOSTRA = 60000;   // caracteres por amostra guardada

  var MAPA = {};             // rota -> { chamadas, campos, amostra, ... }
  var aberto = false;
  var filtro = '';
  var soNovas = false;
  var vistasAntes = {};      // o que ja existia quando a sessao comecou

  /* ============ ESCUTA ============ */
  window.addEventListener('SIA_DADOS', function (ev) {
    var pacote;
    try { pacote = JSON.parse(ev.detail); } catch (e) { return; }
    registrar(pacote);
  });
  // O interceptor segura tudo numa fila ate saber que ha alguem ouvindo.
  // O PING e o que destrava — e ele precisa vir DEPOIS do listener, senao
  // a fila e despejada no vazio. Repetido algumas vezes porque o
  // interceptor pode acordar depois desta linha.
  function avisarQueEstouAqui() {
    try { window.dispatchEvent(new CustomEvent('SIA_PING')); } catch (e) { }
  }
  avisarQueEstouAqui();
  setTimeout(avisarQueEstouAqui, 300);
  setTimeout(avisarQueEstouAqui, 1200);
  setTimeout(avisarQueEstouAqui, 3000);

  function rotaLimpa(url) {
    var u = String(url || '').split('?')[0];
    u = u.replace(/^https?:\/\/[^\/]+/, '');
    // troca ids numericos longos por marcador, senao cada pedido vira rota
    return u.replace(/\/\d{6,}/g, '/{id}');
  }

  function tipoDe(v) {
    if (v === null) return 'nulo';
    if (Array.isArray(v)) return 'lista[' + v.length + ']';
    return typeof v;
  }

  /* Mapeia a estrutura ate 3 niveis, guardando um exemplo de cada campo.
     E o que responde "o que essa rota me da?" sem ler o JSON inteiro. */
  function mapearCampos(obj, prefixo, saida, nivel) {
    if (nivel > 3 || !obj || typeof obj !== 'object') return saida;
    var chaves = Object.keys(obj).slice(0, 60);
    for (var i = 0; i < chaves.length; i++) {
      var k = chaves[i], v = obj[k];
      var caminho = prefixo ? prefixo + '.' + k : k;
      var t = tipoDe(v);
      if (!saida[caminho]) {
        saida[caminho] = { tipo: t, exemplo: null };
        if (v !== null && typeof v !== 'object') {
          saida[caminho].exemplo = String(v).slice(0, 60);
        }
      }
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        mapearCampos(v[0], caminho + '[]', saida, nivel + 1);
      } else if (v && typeof v === 'object') {
        mapearCampos(v, caminho, saida, nivel + 1);
      }
    }
    return saida;
  }

  function registrar(p) {
    if (!p || !p.url) return;
    var rota = rotaLimpa(p.url);
    if (!MAPA[rota]) {
      if (Object.keys(MAPA).length >= MAX_ROTAS) return;
      MAPA[rota] = {
        rota: rota, metodo: p.metodo || 'GET', chamadas: 0,
        campos: {}, corpos: [], params: {}, amostra: null,
        primeiraEm: Date.now(), pagina: location.pathname
      };
    }
    var m = MAPA[rota];
    m.chamadas++;
    m.ultimaEm = Date.now();
    if (p.metodo) m.metodo = p.metodo;

    // parametros da URL, que muitas vezes sao o segredo
    try {
      var qs = String(p.url).split('?')[1];
      if (qs) {
        qs.split('&').forEach(function (par) {
          var kv = par.split('=');
          var k = decodeURIComponent(kv[0] || '');
          if (!k || k === 'SPC_CDS' || k === 'SPC_CDS_VER') return;
          if (!m.params[k]) m.params[k] = decodeURIComponent(kv[1] || '').slice(0, 40);
        });
      }
    } catch (e) { }

    // corpo do POST: o que mais custa descobrir
    if (p.corpo && m.corpos.length < 3) {
      var jaTem = m.corpos.some(function (c) { return c === p.corpo; });
      if (!jaTem) m.corpos.push(String(p.corpo).slice(0, 2000));
    }

    // estrutura da resposta
    if (p.dados) {
      try {
        var raiz = p.dados.data !== undefined ? p.dados.data : p.dados;
        mapearCampos(raiz, '', m.campos, 0);
        if (!m.amostra) m.amostra = JSON.stringify(p.dados).slice(0, MAX_AMOSTRA);
      } catch (e) { }
    }
    // O contador precisa subir mesmo com o painel fechado: e ele que diz
    // que o radar esta captando enquanto voce navega.
    agendarRender();
  }

  /* ============ TELA ============ */
  var host = document.createElement('div');
  host.id = 'radar-shopee';
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;';
  document.documentElement.appendChild(host);
  var raiz = host.attachShadow({ mode: 'open' });
  var $ = function (id) { return raiz.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  raiz.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif}' +
    '.btn{position:fixed;bottom:20px;right:20px;width:52px;height:52px;border-radius:16px;' +
      'background:#0F1115;color:#fff;border:none;cursor:pointer;font-size:22px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.35);display:grid;place-items:center}' +
    '.btn b{position:absolute;top:-6px;right:-6px;background:#E63E1B;color:#fff;font-size:11px;' +
      'min-width:22px;height:22px;border-radius:99px;display:grid;place-items:center;padding:0 5px}' +
    '.painel{position:fixed;top:0;right:0;height:100vh;width:min(760px,100vw);background:#0F1115;' +
      'color:#F2F4F7;display:flex;flex-direction:column;transform:translateX(102%);' +
      'transition:transform .25s;box-shadow:-16px 0 50px rgba(0,0,0,.5)}' +
    '.painel.on{transform:none}' +
    '.cab{padding:16px 20px;border-bottom:1px solid #232833;display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
    '.cab h1{margin:0;font-size:18px;font-weight:600;letter-spacing:-.02em}' +
    '.cab .n{font-size:12px;color:#79818D;font-family:ui-monospace,monospace}' +
    '.acoes{margin-left:auto;display:flex;gap:6px}' +
    'button.a{background:#1A1F27;border:1px solid #2A303B;color:#AEB5C0;font-size:12.5px;' +
      'padding:8px 13px;border-radius:10px;cursor:pointer}' +
    'button.a:hover{border-color:#FF7043;color:#FF7043}' +
    'button.a.on{background:#FF7043;border-color:#FF7043;color:#fff}' +
    '.busca{padding:12px 20px;border-bottom:1px solid #232833}' +
    'input{width:100%;background:#1A1F27;border:1px solid #2A303B;border-radius:10px;' +
      'padding:10px 12px;color:#F2F4F7;font-size:14px}' +
    'input:focus{outline:none;border-color:#FF7043}' +
    '.lista{flex:1;overflow-y:auto;padding:12px 16px 30px}' +
    '.rota{background:#151920;border:1px solid #232833;border-radius:14px;margin-bottom:9px;overflow:hidden}' +
    '.rota.nova{border-color:#FF7043}' +
    '.topo{padding:12px 14px;cursor:pointer;display:flex;align-items:center;gap:10px}' +
    '.topo:hover{background:#1A1F27}' +
    '.met{font-family:ui-monospace,monospace;font-size:10px;padding:2px 7px;border-radius:5px;' +
      'background:#232833;color:#98A0AC;flex:none}' +
    '.met.POST{background:#3A2418;color:#FF9770}' +
    '.cam{flex:1;min-width:0;font-family:ui-monospace,monospace;font-size:12.5px;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.qtd{font-family:ui-monospace,monospace;font-size:11px;color:#79818D;flex:none}' +
    '.tag{font-size:10px;padding:2px 7px;border-radius:99px;border:1px solid #FF7043;color:#FF7043;flex:none}' +
    '.corpo{padding:0 14px 14px;border-top:1px solid #232833;display:none}' +
    '.corpo.on{display:block}' +
    '.sec{font-size:10px;color:#79818D;letter-spacing:.09em;margin:14px 0 7px;font-family:ui-monospace,monospace}' +
    'table{width:100%;border-collapse:collapse;font-size:12px}' +
    'td{padding:4px 6px;border-bottom:1px solid #1A1F27;vertical-align:top}' +
    'td.k{font-family:ui-monospace,monospace;color:#FF9770;width:44%;word-break:break-all}' +
    'td.t{color:#79818D;width:18%;font-family:ui-monospace,monospace}' +
    'td.v{color:#AEB5C0;word-break:break-all}' +
    'pre{background:#0B0D11;border:1px solid #232833;border-radius:10px;padding:11px;' +
      'font-size:11.5px;line-height:1.5;overflow:auto;max-height:260px;margin:0;' +
      'white-space:pre-wrap;word-break:break-all;color:#AEB5C0}' +
    '.vazio{text-align:center;padding:50px 20px;color:#79818D;font-size:14px;line-height:1.6}' +
    '</style>' +
    '<button class="btn" id="abrir" title="Radar Shopee">\u25C9<b id="cont">0</b></button>' +
    '<div class="painel" id="painel">' +
    '  <div class="cab"><div><h1>Radar Shopee</h1>' +
    '    <div class="n" id="resumo">nada capturado ainda</div></div>' +
    '    <div class="acoes">' +
    '      <button class="a" id="novas" title="so o que apareceu depois de marcar">so novas</button>' +
    '      <button class="a" id="marcar" title="marca tudo como visto">marcar</button>' +
    '      <button class="a" id="baixar">baixar</button>' +
    '      <button class="a" id="limpar">limpar</button>' +
    '      <button class="a" id="fechar">\u2715</button>' +
    '    </div></div>' +
    '  <div class="busca"><input id="filtro" placeholder="filtrar por rota, campo ou parametro"></div>' +
    '  <div class="lista" id="lista"></div>' +
    '</div>';

  var timer = null;
  function agendarRender() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; render(); }, 400);
  }

  function render() {
    var rotas = Object.keys(MAPA).sort();
    $('cont').textContent = rotas.length;

    var comPost = rotas.filter(function (r) { return MAPA[r].metodo === 'POST'; }).length;
    var novas = rotas.filter(function (r) { return !vistasAntes[r]; }).length;
    $('resumo').textContent = rotas.length + ' rotas \u00b7 ' + comPost + ' com corpo \u00b7 ' +
      novas + ' novas \u00b7 ' + location.pathname.slice(0, 40);

    if (!aberto) return;
    var q = filtro.toLowerCase();
    var mostrar = rotas.filter(function (r) {
      if (soNovas && vistasAntes[r]) return false;
      if (!q) return true;
      var m = MAPA[r];
      if (r.toLowerCase().indexOf(q) >= 0) return true;
      if (Object.keys(m.campos).some(function (c) { return c.toLowerCase().indexOf(q) >= 0; })) return true;
      if (Object.keys(m.params).some(function (c) { return c.toLowerCase().indexOf(q) >= 0; })) return true;
      return false;
    });

    if (!mostrar.length) {
      $('lista').innerHTML = '<div class="vazio">' +
        (rotas.length
          ? 'Nada com esse filtro.'
          : 'Navegue pela Shopee e as rotas aparecem aqui.<br><br>' +
            'Abra as telas que voce quer mapear \u2014 vendas, financeiro, cadastro de produto, ' +
            'pedidos \u2014 e cada chamada que a pagina faz e registrada com os campos que devolve.') +
        '</div>';
      return;
    }

    var h = '';
    mostrar.forEach(function (r, i) {
      var m = MAPA[r];
      var nCampos = Object.keys(m.campos).length;
      h += '<div class="rota' + (vistasAntes[r] ? '' : ' nova') + '">' +
        '<div class="topo" data-i="' + i + '">' +
        '<span class="met ' + m.metodo + '">' + m.metodo + '</span>' +
        '<span class="cam">' + esc(r) + '</span>' +
        (vistasAntes[r] ? '' : '<span class="tag">nova</span>') +
        '<span class="qtd">' + m.chamadas + 'x \u00b7 ' + nCampos + ' campos</span></div>' +
        '<div class="corpo" id="c' + i + '">';

      if (Object.keys(m.params).length) {
        h += '<div class="sec">PARAMETROS DA URL</div><table>';
        Object.keys(m.params).forEach(function (k) {
          h += '<tr><td class="k">' + esc(k) + '</td><td class="v">' + esc(m.params[k]) + '</td></tr>';
        });
        h += '</table>';
      }
      if (m.corpos.length) {
        h += '<div class="sec">CORPO ENVIADO</div>';
        m.corpos.forEach(function (c) { h += '<pre>' + esc(c) + '</pre>'; });
      }
      if (nCampos) {
        h += '<div class="sec">O QUE ELA DEVOLVE \u00b7 ' + nCampos + ' campos</div><table>';
        Object.keys(m.campos).slice(0, 120).forEach(function (k) {
          var c = m.campos[k];
          h += '<tr><td class="k">' + esc(k) + '</td><td class="t">' + esc(c.tipo) + '</td>' +
            '<td class="v">' + esc(c.exemplo || '') + '</td></tr>';
        });
        h += '</table>';
      }
      if (m.amostra) {
        h += '<div class="sec">RESPOSTA CRUA</div><pre>' + esc(m.amostra.slice(0, 3000)) + '</pre>';
      }
      h += '</div></div>';
    });
    $('lista').innerHTML = h;

    var topos = raiz.querySelectorAll('.topo');
    for (var t = 0; t < topos.length; t++) {
      topos[t].addEventListener('click', function () {
        var c = $('c' + this.getAttribute('data-i'));
        if (c) c.classList.toggle('on');
      });
    }
  }

  /* ============ ACOES ============ */
  $('abrir').addEventListener('click', function () {
    aberto = !aberto;
    $('painel').classList.toggle('on', aberto);
    if (aberto) render();
  });
  $('fechar').addEventListener('click', function () {
    aberto = false; $('painel').classList.remove('on');
  });
  $('filtro').addEventListener('input', function () { filtro = this.value; render(); });
  $('novas').addEventListener('click', function () {
    soNovas = !soNovas; this.classList.toggle('on', soNovas); render();
  });
  $('marcar').addEventListener('click', function () {
    Object.keys(MAPA).forEach(function (r) { vistasAntes[r] = 1; });
    render();
  });
  $('limpar').addEventListener('click', function () {
    if (!confirm('Apagar tudo que foi capturado?')) return;
    MAPA = {}; vistasAntes = {}; render();
  });

  /* Baixa o mapa inteiro. E este arquivo que a gente le depois para
     decidir o que da para construir. */
  $('baixar').addEventListener('click', function () {
    var saida = {
      versao: VERSAO,
      em: new Date().toISOString(),
      pagina: location.href,
      total: Object.keys(MAPA).length,
      rotas: Object.keys(MAPA).sort().map(function (r) {
        var m = MAPA[r];
        return {
          rota: r, metodo: m.metodo, chamadas: m.chamadas,
          pagina: m.pagina,
          parametros: m.params,
          corpos: m.corpos,
          campos: m.campos,
          amostra: m.amostra
        };
      })
    };
    try {
      var blob = new Blob([JSON.stringify(saida, null, 1)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'radar-shopee-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
    } catch (e) {
      alert('Nao consegui gerar o arquivo: ' + e.message);
    }
  });

  render();
  console.log('[Radar Shopee] v' + VERSAO + ' ouvindo. Navegue e clique no circulo no canto.');
})();
