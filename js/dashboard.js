// 대시보드 초기화
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
});

async function loadDashboard() {
  try {
    await Promise.all([
      loadKPI(),
      loadRecentRoasting(),
      loadRecentExtraction(),
      loadRecentBox(),
      loadStockAlert(),
      loadMonthlySales(),
      loadDocumentAlert()
    ]);
  } catch (e) {
    console.error('Dashboard load error:', e);
  }
}

// ─────────────────────────────────────────────
// KPI — kpi_summary 집계 캐시 기반 (장기 최적화)
// 캐시 미스 시 전체 데이터 재집계 후 캐시 재구축
// ─────────────────────────────────────────────
async function loadKPI() {
  try {
    const thisMonth = today().substring(0, 7); // YYYY-MM

    // 4개 컬렉션 캐시를 병렬 조회
    const [roastCache, extCache, boxCache, rawCache] = await Promise.all([
      getKpiCache('roasting_log', thisMonth),
      getKpiCache('extraction_log', thisMonth),
      getKpiCache('box_packing_log', thisMonth),
      getKpiCache('raw_materials', thisMonth),
    ]);

    // ── 원자재 입고 건수 ──
    if (rawCache && rawCache.in_count != null) {
      document.getElementById('kpiRaw').textContent = (rawCache.in_count || 0) + '건';
    } else {
      // 캐시 미스 → 전체 조회 후 캐시 재구축
      const rawRes = await apiGetAll('raw_materials');
      const inCount = rawRes.filter(r =>
        r.transaction_type === '입고' &&
        (r.receive_date || '').startsWith(thisMonth)
      ).length;
      document.getElementById('kpiRaw').textContent = inCount + '건';
      // 백그라운드 캐시 재구축
      _rebuildMonthCache('raw_materials', thisMonth, rawRes);
    }

    // ── 로스팅 이번 달 합계 ──
    if (roastCache && roastCache.roasted_qty_total != null) {
      document.getElementById('kpiRoasting').textContent = numFormat(roastCache.roasted_qty_total, 1) + 'kg';
    } else {
      const roastRes = await apiGetAll('roasting_log');
      const roastTotal = roastRes
        .filter(r => (r.work_date || '').startsWith(thisMonth))
        .reduce((s, r) => s + (parseFloat(r.roasted_qty) || 0), 0);
      document.getElementById('kpiRoasting').textContent = numFormat(roastTotal, 1) + 'kg';
      _rebuildMonthCache('roasting_log', thisMonth, roastRes);
    }

    // ── 추출 이번 달 합계 ──
    if (extCache && extCache.extract_qty_total != null) {
      document.getElementById('kpiExtraction').textContent = numFormat(extCache.extract_qty_total, 1) + 'L';
    } else {
      const extRes = await apiGetAll('extraction_log');
      const extTotal = extRes
        .filter(r => (r.work_date || '').startsWith(thisMonth))
        .reduce((s, r) => s + (parseFloat(r.extract_qty) || 0), 0);
      document.getElementById('kpiExtraction').textContent = numFormat(extTotal, 1) + 'L';
      _rebuildMonthCache('extraction_log', thisMonth, extRes);
    }

    // ── 완제품 박스 이번 달 합계 ──
    if (boxCache && boxCache.box_count_total != null) {
      document.getElementById('kpiBox').textContent = numFormat(boxCache.box_count_total, 0) + 'box';
    } else {
      const boxRes = await apiGetAll('box_packing_log');
      const boxTotal = boxRes
        .filter(r => (r.work_date || '').startsWith(thisMonth))
        .reduce((s, r) => s + (parseInt(r.box_count) || 0), 0);
      document.getElementById('kpiBox').textContent = numFormat(boxTotal, 0) + 'box';
      _rebuildMonthCache('box_packing_log', thisMonth, boxRes);
    }
  } catch (e) {
    console.error('KPI load error:', e);
  }
}

/**
 * 특정 월의 캐시를 백그라운드에서 재구축 (캐시 미스 복구용)
 */
async function _rebuildMonthCache(type, month, allRows) {
  try {
    const db = getFirestore();
    const monthRows = allRows.filter(r => {
      const d = r.work_date || r.receive_date || '';
      return d.startsWith(month);
    });
    const docId = type + '_' + month;
    const data = { type, month, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };

    if (type === 'roasting_log') {
      data.roasted_qty_total = monthRows.reduce((s, r) => s + (parseFloat(r.roasted_qty) || 0), 0);
      data.count = monthRows.length;
    } else if (type === 'extraction_log') {
      data.extract_qty_total = monthRows.reduce((s, r) => s + (parseFloat(r.extract_qty) || 0), 0);
      data.count = monthRows.length;
    } else if (type === 'box_packing_log') {
      data.box_count_total = monthRows.reduce((s, r) => s + (parseInt(r.box_count) || 0), 0);
      data.count = monthRows.length;
    } else if (type === 'raw_materials') {
      data.in_count = monthRows.filter(r => r.transaction_type === '입고').length;
    }

    await db.collection('kpi_summary').doc(docId).set(data, { merge: true });
  } catch (e) {
    console.warn('[KPI Cache] 월별 재구축 실패 (무시됨):', e.message);
  }
}

async function loadRecentRoasting() {
  const container = document.getElementById('recentRoasting');
  try {
    const res = await apiGet('roasting_log', { limit: 100 });
    const rows = (res.data || []).reverse().slice(0, 5);
    if (!rows.length) {
      container.innerHTML = '<div class="empty-msg"><i class="fas fa-inbox"></i>데이터 없음</div>';
      return;
    }
    container.innerHTML = `
      <table class="mini-table">
        <thead><tr><th>Lot No</th><th>날짜</th><th>제품명</th><th>완료량</th><th>품질</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><span class="badge badge-lot" style="cursor:pointer" onclick="goToTrace('${r.lot_no}')">${r.lot_no || '-'}</span></td>
              <td>${r.work_date || '-'}</td>
              <td>${r.product_name || '-'}</td>
              <td>${numFormat(r.roasted_qty, 1)} kg</td>
              <td>${qualityBadge(r.quality_result)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    container.innerHTML = '<div class="empty-msg">데이터 로드 실패</div>';
  }
}

async function loadRecentExtraction() {
  const container = document.getElementById('recentExtraction');
  try {
    const res = await apiGet('extraction_log', { limit: 100 });
    const rows = (res.data || []).reverse().slice(0, 5);
    if (!rows.length) {
      container.innerHTML = '<div class="empty-msg"><i class="fas fa-inbox"></i>데이터 없음</div>';
      return;
    }
    container.innerHTML = `
      <table class="mini-table">
        <thead><tr><th>Lot No</th><th>날짜</th><th>제품명</th><th>추출량</th><th>품질</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><span class="badge badge-lot" style="cursor:pointer" onclick="goToTrace('${r.lot_no}')">${r.lot_no || '-'}</span></td>
              <td>${r.work_date || '-'}</td>
              <td>${r.product_name || '-'}</td>
              <td>${numFormat(r.extract_qty, 1)} L</td>
              <td>${qualityBadge(r.quality_result)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    container.innerHTML = '<div class="empty-msg">데이터 로드 실패</div>';
  }
}

async function loadRecentBox() {
  const container = document.getElementById('recentBox');
  try {
    const res = await apiGet('box_packing_log', { limit: 100 });
    const rows = (res.data || []).reverse().slice(0, 5);
    if (!rows.length) {
      container.innerHTML = '<div class="empty-msg"><i class="fas fa-inbox"></i>데이터 없음</div>';
      return;
    }
    container.innerHTML = `
      <table class="mini-table">
        <thead><tr><th>Lot No</th><th>날짜</th><th>제품명</th><th>박스수</th><th>거래처</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><span class="badge badge-lot" style="cursor:pointer" onclick="goToTrace('${r.lot_no}')">${r.lot_no || '-'}</span></td>
              <td>${r.work_date || '-'}</td>
              <td>${r.product_name || '-'}</td>
              <td>${numFormat(r.box_count, 0)} box</td>
              <td>${r.customer || '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    container.innerHTML = '<div class="empty-msg">데이터 로드 실패</div>';
  }
}

// ─────────────────────────────────────────────
// 이번달 매출 현황
// ─────────────────────────────────────────────
async function loadMonthlySales() {
  const container = document.getElementById('monthlySales');
  if (!container) return;
  try {
    const thisMonth = today().substring(0, 7); // YYYY-MM
    const all = await apiGetAll('sales') || [];
    const monthData = all.filter(r => {
      if (!r.sale_date || !r.sale_date.startsWith(thisMonth)) return false;
      // 샘플/샘플출고 항목 매출 제외 (대시보드 집계에서 제외)
      const prod = String(r.product_name || '').toLowerCase();
      const ch = String(r.channel || '').toLowerCase();
      if (prod.includes('샘플') || ch.includes('샘플')) return false;
      return true;
    });

    if (!monthData.length) {
      container.innerHTML = '<div class="empty-msg"><i class="fas fa-inbox"></i> 이번달 매출 데이터 없음</div>';
      return;
    }

    // 채널별 집계
    const channelMap = {};
    let totalPayment = 0;
    let totalSettlement = 0;
    monthData.forEach(r => {
      const ch = r.channel || '기타';
      if (!channelMap[ch]) channelMap[ch] = { payment: 0, settlement: 0, count: 0 };
      channelMap[ch].payment += parseFloat(r.payment) || 0;
      channelMap[ch].settlement += parseFloat(r.settlement) || 0;
      channelMap[ch].count += 1;
      totalPayment += parseFloat(r.payment) || 0;
      totalSettlement += parseFloat(r.settlement) || 0;
    });

    const rows = Object.entries(channelMap)
      .sort((a, b) => b[1].settlement - a[1].settlement);

    container.innerHTML = `
      <div style="margin-bottom:8px;display:flex;gap:16px;flex-wrap:wrap">
        <span style="font-size:12px;color:#555">결제합계: <strong style="color:#2C5F2E">${numFormat(totalPayment, 0)}원</strong></span>
        <span style="font-size:12px;color:#555">정산합계: <strong style="color:#2980b9">${numFormat(totalSettlement, 0)}원</strong></span>
        <span style="font-size:12px;color:#555">건수: <strong>${monthData.length}건</strong></span>
      </div>
      <table class="mini-table">
        <thead><tr><th>채널</th><th>건수</th><th>결제금액</th><th>정산금액</th></tr></thead>
        <tbody>
          ${rows.map(([ch, v]) => `
            <tr>
              <td>${ch}</td>
              <td>${v.count}건</td>
              <td>${numFormat(v.payment, 0)}원</td>
              <td><strong>${numFormat(v.settlement, 0)}원</strong></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    const container2 = document.getElementById('monthlySales');
    if (container2) container2.innerHTML = '<div class="empty-msg"><i class="fas fa-inbox"></i> 이번달 매출 데이터 없음</div>';
  }
}

// ─────────────────────────────────────────────
// 서류 갱신 알림
// ─────────────────────────────────────────────
async function loadDocumentAlert() {
  const container = document.getElementById('documentAlert');
  if (!container) return;
  try {
    const all = await apiGetAll('vendors') || [];
    const todayStr = today(); // YYYY-MM-DD
    const alerts = [];

    all.forEach(v => {
      const name = v.vendor_name || v.company_name || v.name || '(거래처명 없음)';
      // 각 서류별 확인
      const docs = [
        { label: '사업자등록증', date: v.doc_registration_date, status: v.doc_registration_status },
        { label: '통장사본', date: v.doc_bank_date, status: v.doc_bank_status },
        { label: '기타서류', date: v.doc_other_date, status: v.doc_other_status },
      ];
      // 추가 서류 (extra)
      if (v.extra_docs && Array.isArray(v.extra_docs)) {
        v.extra_docs.forEach((d, i) => {
          docs.push({ label: d.name || `추가서류${i+1}`, date: d.date, status: d.status });
        });
      }
      docs.forEach(doc => {
        if (!doc.date) return;
        // 기한만료 상태이거나 등록일로부터 1년(365일) 이내 갱신 필요 판단
        const docDate = new Date(doc.date);
        const todayDate = new Date(todayStr);
        const diffDays = Math.floor((todayDate - docDate) / (1000 * 60 * 60 * 24));
        const isExpired = doc.status === '기한만료';
        const isSoonExpire = diffDays >= 335; // 등록일로부터 335일 이상 = 30일 이내 갱신 필요
        if (isExpired || isSoonExpire) {
          alerts.push({
            vendor: name,
            doc: doc.label,
            date: doc.date,
            status: doc.status || '-',
            diffDays,
            isExpired
          });
        }
      });
    });

    if (!alerts.length) {
      container.innerHTML = '<div class="empty-msg" style="color:#27ae60"><i class="fas fa-check-circle"></i> 갱신 필요 서류 없음</div>';
      return;
    }

    // 만료 우선 정렬
    alerts.sort((a, b) => b.diffDays - a.diffDays);

    container.innerHTML = `
      <table class="mini-table">
        <thead><tr><th>거래처</th><th>서류</th><th>등록일</th><th>상태</th></tr></thead>
        <tbody>
          ${alerts.slice(0, 8).map(a => `
            <tr>
              <td>${a.vendor}</td>
              <td>${a.doc}</td>
              <td>${a.date}</td>
              <td>${a.isExpired
                ? '<span class="badge badge-danger">기한만료</span>'
                : '<span class="badge badge-warning" style="background:#fff3cd;color:#856404">갱신임박</span>'
              }</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    const container2 = document.getElementById('documentAlert');
    if (container2) container2.innerHTML = '<div class="empty-msg"><i class="fas fa-inbox"></i> 서류 데이터 없음</div>';
  }
}

async function loadStockAlert() {
  const container = document.getElementById('stockAlert');
  try {
    const todayStr = today(); // YYYY-MM-DD
    const soon = new Date(todayStr);
    soon.setDate(soon.getDate() + 30);
    const soonStr = soon.toISOString().split('T')[0]; // 30일 이내 소비기한 기준

    // 물류관리2 데이터 및 제품마스터정보2 기준 정보 병렬 조회
    const [inboundRes, outboundRes, auditRes, configRes, productsRes] = await Promise.all([
      apiGetAll('lg2_inbound').catch(() => []),
      apiGetAll('lg2_outbound').catch(() => []),
      apiGetAll('lg2_audit').catch(() => []),
      apiGetAll('lg2_stocktake_config').catch(() => []),
      apiGetAll('products2').catch(() => [])
    ]);

    // 제품마스터정보2 적정재고량 맵 { 품목명: min_stock }
    const minStockMap = {};
    (productsRes || []).forEach(p => {
      if (p.product_name && p.min_stock > 0) minStockMap[p.product_name] = p.min_stock;
    });

    // 실사 기준일 확인
    let baseDate = null;
    if (configRes && configRes.length > 0) {
      baseDate = configRes.reduce((a, b) => ((a.base_date || '') > (b.base_date || '') ? a : b)).base_date || null;
    }

    // 품목별 FIFO 재고 계산 (lg2GetFifoStock 간소화 버전)
    const allItems = new Set();
    (inboundRes || []).forEach(r => r.item_name && allItems.add(r.item_name));
    (auditRes || []).forEach(r => r.item_name && allItems.add(r.item_name));

    const stockAlerts = []; // { name, stock, minStock, expiry, status }

    allItems.forEach(itemName => {
      const inRows = (inboundRes || []).filter(r => r.item_name === itemName);
      const outRows = (outboundRes || []).filter(r => r.item_name === itemName);
      const audRows = (auditRes || []).filter(r => r.item_name === itemName);

      // 실사 스냅샷 기준일 적용
      let totalStock = 0;
      let earliestExpiry = '';

      if (baseDate) {
        // 기준일 이하 실사 중 가장 최신것
        const snap = audRows
          .filter(a => (a.date || a.audit_date || '') <= baseDate)
          .sort((a, b) => ((b.date || b.audit_date || '') > (a.date || a.audit_date || '') ? 1 : -1))[0];
        const snapQty = snap ? (Number(snap.actual_qty) || 0) : 0;
        // 기준일 이후 입고 - 출고
        const inAfter = inRows.filter(r => r.date && r.date > baseDate).reduce((s, r) => s + (Number(r.qty_ea) || 0), 0);
        const outAfter = outRows.filter(r => r.date && r.date > baseDate).reduce((s, r) => s + (Number(r.qty_ea) || 0), 0);
        totalStock = snapQty + inAfter - outAfter;
      } else {
        // 기준일 없으면 전체 입출고 합산
        const inTotal = inRows.reduce((s, r) => s + (Number(r.qty_ea) || 0), 0);
        const outTotal = outRows.reduce((s, r) => s + (Number(r.qty_ea) || 0), 0);
        totalStock = inTotal - outTotal;
      }

      // 가장 빠른 소비기한 (입고 데이터 기준)
      const expiries = inRows.map(r => r.expiry).filter(e => e && e > todayStr).sort();
      earliestExpiry = expiries[0] || '';

      const minStock = minStockMap[itemName] || 0;
      let status = '정상';
      if (totalStock <= 0) status = '재고없음';
      else if (minStock > 0 && totalStock < minStock) status = '부족';
      else if (earliestExpiry && earliestExpiry <= soonStr) status = '소비기한임박';

      if (status !== '정상') {
        stockAlerts.push({ name: itemName, stock: totalStock, minStock, expiry: earliestExpiry, status });
      }
    });

    if (!stockAlerts.length) {
      container.innerHTML = '<div class="empty-msg"><i class="fas fa-check-circle" style="color:#27ae60"></i> 재고 이상 없음</div>';
      return;
    }

    // 상태 우선순서: 재고없음 > 부족 > 소비기한임박
    const order = { '재고없음': 0, '부족': 1, '소비기한임박': 2 };
    stockAlerts.sort((a, b) => (order[a.status] || 9) - (order[b.status] || 9));

    const badgeMap = {
      '재고없음': '<span class="badge" style="background:#e74c3c;color:#fff">재고없음</span>',
      '부족':     '<span class="badge" style="background:#f39c12;color:#fff">부족</span>',
      '소비기한임박': '<span class="badge" style="background:#8e44ad;color:#fff">소비기임박</span>'
    };

    container.innerHTML = `
      <table class="mini-table">
        <thead><tr><th>품목명</th><th>현재재고</th><th>적정재고</th><th>상태</th></tr></thead>
        <tbody>
          ${stockAlerts.slice(0, 8).map(r => `
            <tr>
              <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name}">${r.name}</td>
              <td style="text-align:right"><strong>${numFormat(r.stock, 0)}</strong></td>
              <td style="text-align:right;color:#888">${r.minStock > 0 ? numFormat(r.minStock, 0) : '-'}</td>
              <td>${badgeMap[r.status] || ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${stockAlerts.length > 8 ? `<div style="font-size:11px;color:#888;text-align:right;margin-top:4px">외 ${stockAlerts.length - 8}건 더 있음</div>` : ''}
    `;
  } catch (e) {
    console.error('[stockAlert]', e);
    container.innerHTML = '<div class="empty-msg">데이터 로드 실패</div>';
  }
}
