// ============================================================
// SELLER.IA — CALCULADORA DE MARGEM REAL
// v1.0.0
// ------------------------------------------------------------
// O que a Shopee NAO te da mastigado: a margem cruzando TODOS os
// custos. Shopee mostra o que ela cobra; so voce sabe o custo do
// produto e o gasto de ads. O cruzamento revela: lucra ou nao?
//
// Custo Shopee = comissao(%) + taxa fixa, por faixa de preco
// (regra da Karina). ROAS minimo = 100 / margem%.
// ============================================================
(function () {
  'use strict';
  if (window.SIA_Calc) return;
  var VERSAO = '1.0.0';

  // tabela de comissao por faixa (Metodo Efeito Vendas)
  function taxaShopee(preco) {
    if (preco < 80) return { comissao: 20, fixa: 4, faixa: 'ate R$ 79,99' };
    if (preco < 100) return { comissao: 14, fixa: 16, faixa: 'R$ 80 a 99,99' };
    if (preco < 200) return { comissao: 14, fixa: 20, faixa: 'R$ 100 a 199,99' };
    return { comissao: 14, fixa: 26, faixa: 'R$ 200+' };
  }

  // calcula a margem real de um produto
  // ent = { preco, custo, outros, impostoPct, adsReais, antecipaPct }
  function margem(ent) {
    var preco = num(ent.preco);
    if (!preco || preco <= 0) return null;
    var custo = num(ent.custo) || 0;
    var outros = num(ent.outros) || 0;
    var impostoPct = num(ent.impostoPct) || 0;
    var antecipaPct = num(ent.antecipaPct) || 0;
    var adsReais = num(ent.adsReais) || 0;

    var tx = taxaShopee(preco);
    var comissaoR = preco * (tx.comissao / 100);
    var impostoR = preco * (impostoPct / 100);
    var antecipaR = preco * (antecipaPct / 100);

    var lucro = preco - custo - outros - tx.fixa - comissaoR - impostoR - antecipaR - adsReais;
    var margemPct = preco > 0 ? (lucro / preco * 100) : 0;
    // ROAS minimo pra nao ter prejuizo com ads = 100 / margem-sem-ads%
    var margemSemAds = preco > 0 ? ((lucro + adsReais) / preco * 100) : 0;
    var roasMinimo = margemSemAds > 0 ? (100 / margemSemAds) : null;

    return {
      preco: preco,
      faixa: tx.faixa,
      custoProduto: custo,
      outros: outros,
      taxaFixa: tx.fixa,
      comissao: { pct: tx.comissao, reais: round2(comissaoR) },
      imposto: { pct: impostoPct, reais: round2(impostoR) },
      antecipa: { pct: antecipaPct, reais: round2(antecipaR) },
      ads: round2(adsReais),
      lucro: round2(lucro),
      margemPct: round1(margemPct),
      margemSemAds: round1(margemSemAds),
      roasMinimo: roasMinimo ? round1(roasMinimo) : null,
      noLucro: lucro > 0
    };
  }

  // cruza a margem com o ROAS real do ads (o pulo do gato)
  // veredito: verde (folga), amarelo (no limite), vermelho (prejuizo)
  function cruzarAds(margemObj, roasReal) {
    if (!margemObj || !margemObj.roasMinimo) return null;
    var min = margemObj.roasMinimo;
    var real = num(roasReal);
    if (!real) return { nivel: 'cinza', texto: 'Sem ROAS real capturado pra cruzar. O minimo pra empatar e ' + min + 'x.' };
    if (real >= min * 1.3) return { nivel: 'verde', texto: 'ROAS ' + real.toFixed(1) + 'x com folga sobre o minimo de ' + min + 'x. Lucra bem.' };
    if (real >= min) return { nivel: 'amarelo', texto: 'ROAS ' + real.toFixed(1) + 'x acima do minimo de ' + min + 'x, mas sem folga. Cuidado ao escalar.' };
    return { nivel: 'vermelho', texto: 'ROAS ' + real.toFixed(1) + 'x ABAIXO do minimo de ' + min + 'x. Cada venda por ads sai no prejuizo.' };
  }

  // helpers
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v == null || v === '') return null;
    var x = parseFloat(String(v).replace(',', '.'));
    return isFinite(x) ? x : null;
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function round1(v) { return Math.round(v * 10) / 10; }

  window.SIA_Calc = {
    versao: VERSAO,
    taxaShopee: taxaShopee,
    margem: margem,
    cruzarAds: cruzarAds
  };
})();
