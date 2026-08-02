// ============================================================
// SELLER.IA — MOTOR DE TRIAGEM (Camada 2, metade LOCAL)
// v1.0.0
// ------------------------------------------------------------
// O SEMAFORO. Roda no navegador, instantaneo, sem servidor.
// Pega N campanhas (1 ou 10 mil) do cofre de diamantes e pinta
// cada uma:  vermelho / amarelo / verde / cinza.
//
// Regras do algoritmo oCPM (do config/get, ja mapeadas):
//  - aprendizado 7 dias (cold start) -> nao julgar -> CINZA
//  - meta so muda 20% por vez, 1x/dia -> acao respeita isso
//  - a Shopee entrega a meta sugerida por campanha (suggested_roi)
//  - ROAS minimo = 100 / margem%  (Metodo Efeito Vendas)
//
// NAO contem o metodo secreto (isso fica no servidor). Aqui e
// so a triagem rapida que a pessoa ve na tela na hora.
// ============================================================
(function () {
  'use strict';
  if (window.SIA_Triagem) return;

  var VERSAO = '1.0.0';

  // margem padrao quando o custo do produto ainda nao foi informado.
  // (o Cofre de Custos entra na Camada 4; ate la, usamos um piso seguro)
  var MARGEM_PADRAO = 0.25; // 25%
  var COLD_START_DIAS = 7;  // regra do algoritmo: nao julgar antes disso

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  // ROAS minimo de sobrevivencia = 100 / margem%.
  // margem 25% -> ROAS 4x. E o piso: abaixo disso, a campanha da prejuizo.
  function roasMinimo(margemPct) {
    var m = (margemPct && margemPct > 0) ? margemPct : MARGEM_PADRAO;
    return 100 / (m * 100); // 100 / 25 = 4
  }

  // ----------------------------------------------------------
  // classificar UMA campanha -> devolve cor + porque + acao
  // ----------------------------------------------------------
  // pc = objeto porCampanha[id] do cofre de diamantes
  // opts = { margemPct, diasConta }
  function classificar(pc, opts) {
    opts = opts || {};
    var margem = opts.margemPct || MARGEM_PADRAO;
    var piso = roasMinimo(margem); // ex 4x

    var leilao = pc.leilao || {};
    var funil = pc.funil || {};
    var res = pc.resultado || {};
    var meta = pc.metaShopee || null;

    var gasto = num(leilao.gasto);
    var roas = num(res.roiAmplo) || num(res.roiDireto);
    var pedidos = num(res.pedidos);
    var cliques = num(funil.cliques);
    var impressoes = num(funil.impressoes);

    // ---- CINZA: ainda aprendendo (sem sinal suficiente pra julgar) ----
    // sem gasto e sem pedido = nao rodou de verdade no periodo
    if (gasto === 0 && pedidos === 0 && cliques < 5) {
      return cor('cinza', 'Sem movimento no periodo', 'Aguardando dados. Nada a fazer agora.', 0, pc);
    }
    // gastou pouco e teve poucos cliques = ainda coletando aprendizado
    if (gasto > 0 && cliques < 10 && pedidos === 0) {
      return cor('cinza', 'Em aprendizado', 'Deixe rodar ate juntar mais cliques antes de decidir.', gasto, pc);
    }

    // ---- VERMELHO: sangrando ----
    // gastou de verdade, teve cliques, mas nao converteu nada
    if (gasto > 0 && pedidos === 0 && cliques >= 20) {
      return cor('vermelho',
        'Gasta e nao converte',
        'Ja teve ' + cliques + ' cliques sem nenhuma venda. Provavel problema de preco ou pagina, nao de anuncio.',
        gasto, pc, { tipo: 'investigar_pagina' });
    }
    // ROAS real abaixo do piso de sobrevivencia
    if (roas > 0 && roas < piso && gasto > 0) {
      return cor('vermelho',
        'ROAS abaixo do minimo',
        'Esta em ' + roas.toFixed(1) + 'x, abaixo do seu piso de ' + piso.toFixed(1) + 'x. Nesse ritmo, cada venda sai no prejuizo.',
        gasto, pc, { tipo: 'baixar_ou_pausar', pisoRoas: piso });
    }
    // a Shopee sugere baixar MUITO a meta (mais de 30%) = voce esta sufocando o proprio trafego
    if (meta && meta.atual && meta.sugerida && meta.sugerida < meta.atual * 0.7) {
      return cor('amarelo',
        'Sufocada por ROAS alto',
        'Voce esta em ' + meta.atual.toFixed(1) + 'x e a Shopee indica ' + meta.sugerida.toFixed(1) + 'x. Isso segura seu volume.' +
          (meta.ganhoGmvPct ? ' Ha espaco pra crescer ~' + meta.ganhoGmvPct + '% em vendas.' : ''),
        gasto, pc, { tipo: 'baixar_meta_passos', metaSugerida: meta.sugerida, metaAtual: meta.atual });
    }
    // a Shopee sugere baixar um pouco (10-30%) = ajuste fino
    if (meta && meta.atual && meta.sugerida && meta.sugerida < meta.atual * 0.9) {
      return cor('amarelo',
        'Espaco pra mais volume',
        'Baixar a meta de ' + meta.atual.toFixed(1) + 'x para ~' + meta.sugerida.toFixed(1) + 'x tende a liberar mais trafego.',
        gasto, pc, { tipo: 'baixar_meta_passos', metaSugerida: meta.sugerida, metaAtual: meta.atual });
    }

    // ---- VERDE: saudavel/escalando ----
    // ROAS acima do piso com folga e convertendo
    if (roas >= piso && pedidos > 0) {
      // a Shopee sugere MANTER ou SUBIR = pode escalar orcamento
      var podeEscalar = !meta || !meta.sugerida || meta.sugerida >= (meta.atual || 0) * 0.95;
      if (podeEscalar) {
        return cor('verde',
          'Saudavel — pode escalar',
          'ROAS ' + roas.toFixed(1) + 'x com ' + pedidos + ' pedido(s). Boa candidata a aumentar orcamento aos poucos.',
          gasto, pc, { tipo: 'aumentar_orcamento' });
      }
      return cor('verde',
        'Saudavel',
        'ROAS ' + roas.toFixed(1) + 'x, dentro do alvo. Mantenha e observe.',
        gasto, pc, { tipo: 'manter' });
    }

    // fallback: rodou mas nao encaixou em nenhum caso claro
    return cor('cinza', 'Sem veredito claro',
      'Dados insuficientes pra uma recomendacao segura. Observe mais alguns dias.',
      gasto, pc);
  }

  function cor(nivel, titulo, texto, gasto, pc, acao) {
    return {
      nivel: nivel,                    // vermelho | amarelo | verde | cinza
      titulo: titulo,
      texto: texto,
      gasto: gasto,
      campanha: pc.titulo || null,
      posicao: (pc.leilao && pc.leilao.posicao) || null,
      cpm: (pc.leilao && pc.leilao.cpm) || null,
      roas: (pc.resultado && (pc.resultado.roiAmplo || pc.resultado.roiDireto)) || null,
      acao: acao || null
    };
  }

  // ----------------------------------------------------------
  // triar TODAS as campanhas do cofre -> resumo + fila priorizada
  // ----------------------------------------------------------
  // Campanha pausada nao esta gastando agora: julgar como se estivesse
  // enche a fila de acao com coisa que nao acontece mais. Ela so volta a
  // aparecer se tiver gerado receita relevante no periodo — ai vira
  // oportunidade ("isto vendia bem e esta parado"), nao problema.
  function estaPausada(c) {
    var e = String((c && (c.estado || c.state)) || '').toLowerCase();
    return e === 'paused' || e === 'ended' || e === 'closed';
  }
  function triar(cofre, opts) {
    opts = opts || {};
    var porCampanha = (cofre && cofre.porCampanha) || {};
    var ids = Object.keys(porCampanha);

    var resultado = {
      total: ids.length,
      contagem: { vermelho: 0, amarelo: 0, verde: 0, cinza: 0 },
      gastoTotal: 0,
      fila: []   // ordenada por impacto (gasto x urgencia)
    };

    resultado.pausadas = { total: 0, comReceita: [] };
    ids.forEach(function (id) {
      var pc = porCampanha[id];
      var c = classificar(pc, opts);
      c.id = id;

      // Pausada nao gasta agora: julgar como se gastasse enche a fila de
      // acao com coisa que nao acontece mais. Ela sai da contagem e da fila,
      // mas se vendeu bem no periodo vira OPORTUNIDADE, nao problema.
      if (estaPausada(pc)) {
        resultado.pausadas.total++;
        var gmvP = (pc && pc.metricas && pc.metricas.gmv) || 0;
        var roasP = (pc && pc.metricas && pc.metricas.roas) || 0;
        if (gmvP >= 300 && roasP >= (opts.roasMinimo || 4)) {
          c.pausadaBoa = true;
          resultado.pausadas.comReceita.push(c);
        }
        return;
      }

      resultado.contagem[c.nivel]++;
      resultado.gastoTotal += c.gasto;
      // so entra na fila de acao quem NAO e verde nem cinza sem acao
      if (c.nivel === 'vermelho' || c.nivel === 'amarelo' || (c.nivel === 'verde' && c.acao && c.acao.tipo === 'aumentar_orcamento')) {
        resultado.fila.push(c);
      }
    });
    resultado.pausadas.comReceita.sort(function (a, b) {
      return ((b.gmv || 0) - (a.gmv || 0));
    });

    // PRIORIZACAO POR IMPACTO EM REAIS, nao por gravidade.
    // peso: vermelho que gasta muito > amarelo que gasta muito >
    //       verde escalavel > o resto. Dentro do nivel, ordena por gasto.
    var pesoNivel = { vermelho: 3, amarelo: 2, verde: 1, cinza: 0 };
    resultado.fila.sort(function (a, b) {
      var pa = pesoNivel[a.nivel] * 1000 + a.gasto;
      var pb = pesoNivel[b.nivel] * 1000 + b.gasto;
      return pb - pa;
    });

    return resultado;
  }

  window.SIA_Triagem = {
    versao: VERSAO,
    classificar: classificar,   // uma campanha
    triar: triar,               // todas
    roasMinimo: roasMinimo
  };
})();
