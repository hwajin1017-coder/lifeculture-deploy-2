// =====================================================
// Lot 역추적 JS (traceability.js)
// 박스포장 Lot 기준 역추적: BOX → BTL → EXT → GRIND → ROAST → RM(생두)
// 다른 공정 Lot 입력 시 해당 공정에서 양방향 추적
// =====================================================

async function startTrace() {
  const lotNo = (document.getElementById('traceInput')?.value || '').trim();
  if (!lotNo) { showToast('Lot 번호를 입력해주세요.', 'warning'); return; }

  ['traceEmpty','traceResult','traceNotFound'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const loading = document.getElementById('traceLoading');
  if (loading) loading.style.display = 'block';

  try {
    const prefix = lotNo.split('-')[0].toUpperCase();
    let traceData = {};
    // 엑셀 규칙 3자리 + 기존 접두어 모두 지원
    // CTN(완제품박스포장) = BOX, RST(로스팅) = ROAST, GRD(분쇄) = GRIND
    if (prefix === 'CTN' || prefix === 'BOX') {
      traceData = await traceFromBox(lotNo);
    } else if (prefix === 'BTL') {
      traceData = await traceFromBottle(lotNo);
    } else if (prefix === 'EXT') {
      traceData = await traceFromExtraction(lotNo);
    } else if (prefix === 'GRD' || prefix === 'GRIND') {
      traceData = await traceFromGrinding(lotNo);
    } else if (prefix === 'RST' || prefix === 'ROAST') {
      traceData = await traceFromRoasting(lotNo);
    } else if (prefix === 'RM') {
      traceData = await traceFromRaw(lotNo);
    } else {
      traceData = await traceFromAny(lotNo);
    }

    if (loading) loading.style.display = 'none';

    if (!traceData || !traceData.found) {
      const notFound = document.getElementById('traceNotFound');
      if (notFound) notFound.style.display = 'block';
      return;
    }

    renderTraceResult(traceData, lotNo);
    const result = document.getElementById('traceResult');
    if (result) result.style.display = 'block';
  } catch(err) {
    if (loading) loading.style.display = 'none';
    const notFound = document.getElementById('traceNotFound');
    if (notFound) notFound.style.display = 'block';
    console.error('Trace error:', err);
  }
}

// =====================================================
// 전체 데이터 로드
// =====================================================
async function loadAllData() {
  const [raw, roast, grind, ext, btl, box] = await Promise.all([
    apiGetAll('raw_materials').catch(() => []),
    apiGetAll('roasting_log').catch(() => []),
    apiGetAll('grinding_log').catch(() => []),
    apiGetAll('extraction_log').catch(() => []),
    apiGetAll('bottle_packing_log').catch(() => []),
    apiGetAll('box_packing_log').catch(() => []),
  ]);
  return { raw, roast, grind, ext, btl, box };
}

// =====================================================
// 박스포장 Lot 기준 역추적 (★ 메인 추적 방향)
// BOX → BTL → EXT → GRIND → ROAST → RM
// =====================================================
async function traceFromBox(lotNo, allData) {
  const all = allData || await loadAllData();
  const boxRec = all.box.find(r => r.lot_no === lotNo);
  if (!boxRec) return { found: false };

  // 박스 → 병포장 역추적
  const btlRec = all.btl.find(r => r.lot_no === boxRec.bottle_lot_no) || null;
  const extRec = btlRec ? (all.ext.find(r => r.lot_no === btlRec.extract_lot_no) || null) : null;
  const grindRec = extRec ? (all.grind.find(r => r.lot_no === extRec.grind_lot_no) || null) : null;
  const roastRec = grindRec ? (all.roast.find(r => r.lot_no === grindRec.roast_lot_no) || null) : null;

  // 로스팅에서 생두 Lot 추적 (블랜딩 3가지 지원)
  const rawRecs = [];
  if (roastRec) {
    const rawLots = [roastRec.raw_lot_1, roastRec.raw_lot_2, roastRec.raw_lot_3].filter(Boolean);
    rawLots.forEach(lot => {
      const r = all.raw.find(rec => rec.lot_no === lot);
      if (r) rawRecs.push(r);
    });
  }

  return {
    found: true,
    traceBasis: 'box',
    boxRec,
    btlRec,
    extRec,
    grindRec,
    roastRec,
    rawRecs,
    rawRec: rawRecs[0] || null,
  };
}

// =====================================================
// 병포장 Lot 기준 역추적
// =====================================================
async function traceFromBottle(lotNo, allData) {
  const all = allData || await loadAllData();
  const btlRec = all.btl.find(r => r.lot_no === lotNo);
  if (!btlRec) return { found: false };

  const boxRec = all.box.find(r => r.bottle_lot_no === lotNo) || null;
  const extRec = all.ext.find(r => r.lot_no === btlRec.extract_lot_no) || null;
  const grindRec = extRec ? (all.grind.find(r => r.lot_no === extRec.grind_lot_no) || null) : null;
  const roastRec = grindRec ? (all.roast.find(r => r.lot_no === grindRec.roast_lot_no) || null) : null;
  const rawRecs = [];
  if (roastRec) {
    [roastRec.raw_lot_1, roastRec.raw_lot_2, roastRec.raw_lot_3].filter(Boolean).forEach(lot => {
      const r = all.raw.find(rec => rec.lot_no === lot);
      if (r) rawRecs.push(r);
    });
  }

  return { found: true, traceBasis: 'btl', boxRec, btlRec, extRec, grindRec, roastRec, rawRecs, rawRec: rawRecs[0] || null };
}

// =====================================================
// 추출 Lot 기준
// =====================================================
async function traceFromExtraction(lotNo, allData) {
  const all = allData || await loadAllData();
  const extRec = all.ext.find(r => r.lot_no === lotNo);
  if (!extRec) return { found: false };

  const btlRec = all.btl.find(r => r.extract_lot_no === lotNo) || null;
  const boxRec = btlRec ? (all.box.find(r => r.bottle_lot_no === btlRec.lot_no) || null) : null;
  const grindRec = all.grind.find(r => r.lot_no === extRec.grind_lot_no) || null;
  const roastRec = grindRec ? (all.roast.find(r => r.lot_no === grindRec.roast_lot_no) || null) : null;
  const rawRecs = [];
  if (roastRec) {
    [roastRec.raw_lot_1, roastRec.raw_lot_2, roastRec.raw_lot_3].filter(Boolean).forEach(lot => {
      const r = all.raw.find(rec => rec.lot_no === lot);
      if (r) rawRecs.push(r);
    });
  }
  return { found: true, traceBasis: 'ext', boxRec, btlRec, extRec, grindRec, roastRec, rawRecs, rawRec: rawRecs[0] || null };
}

// =====================================================
// 분쇄 Lot 기준
// =====================================================
async function traceFromGrinding(lotNo, allData) {
  const all = allData || await loadAllData();
  const grindRec = all.grind.find(r => r.lot_no === lotNo);
  if (!grindRec) return { found: false };

  const extRec = all.ext.find(r => r.grind_lot_no === lotNo) || null;
  const btlRec = extRec ? (all.btl.find(r => r.extract_lot_no === extRec.lot_no) || null) : null;
  const boxRec = btlRec ? (all.box.find(r => r.bottle_lot_no === btlRec.lot_no) || null) : null;
  const roastRec = all.roast.find(r => r.lot_no === grindRec.roast_lot_no) || null;
  const rawRecs = [];
  if (roastRec) {
    [roastRec.raw_lot_1, roastRec.raw_lot_2, roastRec.raw_lot_3].filter(Boolean).forEach(lot => {
      const r = all.raw.find(rec => rec.lot_no === lot);
      if (r) rawRecs.push(r);
    });
  }
  return { found: true, traceBasis: 'grind', boxRec, btlRec, extRec, grindRec, roastRec, rawRecs, rawRec: rawRecs[0] || null };
}

// =====================================================
// 로스팅 Lot 기준
// =====================================================
async function traceFromRoasting(lotNo, allData) {
  const all = allData || await loadAllData();
  const roastRec = all.roast.find(r => r.lot_no === lotNo);
  if (!roastRec) return { found: false };

  const grindRec = all.grind.find(r => r.roast_lot_no === lotNo) || null;
  const extRec = grindRec ? (all.ext.find(r => r.grind_lot_no === grindRec.lot_no) || null) : null;
  const btlRec = extRec ? (all.btl.find(r => r.extract_lot_no === extRec.lot_no) || null) : null;
  const boxRec = btlRec ? (all.box.find(r => r.bottle_lot_no === btlRec.lot_no) || null) : null;
  const rawRecs = [];
  [roastRec.raw_lot_1, roastRec.raw_lot_2, roastRec.raw_lot_3].filter(Boolean).forEach(lot => {
    const r = all.raw.find(rec => rec.lot_no === lot);
    if (r) rawRecs.push(r);
  });
  return { found: true, traceBasis: 'roast', boxRec, btlRec, extRec, grindRec, roastRec, rawRecs, rawRec: rawRecs[0] || null };
}

// =====================================================
// 생두 입고 Lot 기준 (정방향 추적)
// =====================================================
async function traceFromRaw(lotNo, allData) {
  const all = allData || await loadAllData();
  const rawRec = all.raw.find(r => r.lot_no === lotNo);
  if (!rawRec) return { found: false };

  // 생두 Lot를 사용한 로스팅 찾기 (블랜딩 포함)
  const roastRec = all.roast.find(r =>
    r.raw_lot_1 === lotNo || r.raw_lot_2 === lotNo || r.raw_lot_3 === lotNo
  ) || null;
  const grindRec = roastRec ? (all.grind.find(r => r.roast_lot_no === roastRec.lot_no) || null) : null;
  const extRec = grindRec ? (all.ext.find(r => r.grind_lot_no === grindRec.lot_no) || null) : null;
  const btlRec = extRec ? (all.btl.find(r => r.extract_lot_no === extRec.lot_no) || null) : null;
  const boxRec = btlRec ? (all.box.find(r => r.bottle_lot_no === btlRec.lot_no) || null) : null;

  return { found: true, traceBasis: 'raw', boxRec, btlRec, extRec, grindRec, roastRec, rawRecs: [rawRec], rawRec };
}

// =====================================================
// 임의 Lot 검색
// =====================================================
async function traceFromAny(lotNo) {
  const all = await loadAllData();
  if (all.box.find(r => r.lot_no === lotNo)) return traceFromBox(lotNo, all);
  if (all.btl.find(r => r.lot_no === lotNo)) return traceFromBottle(lotNo, all);
  if (all.ext.find(r => r.lot_no === lotNo)) return traceFromExtraction(lotNo, all);
  if (all.grind.find(r => r.lot_no === lotNo)) return traceFromGrinding(lotNo, all);
  if (all.roast.find(r => r.lot_no === lotNo)) return traceFromRoasting(lotNo, all);
  if (all.raw.find(r => r.lot_no === lotNo)) return traceFromRaw(lotNo, all);
  return { found: false };
}

// =====================================================
// 결과 렌더링
// =====================================================
function renderTraceResult(data, inputLot) {
  const { boxRec, btlRec, extRec, grindRec, roastRec, rawRecs, rawRec, traceBasis } = data;

  // 박스포장 Lot 강조
  const boxPrimary = document.getElementById('boxLotPrimary');
  const boxPrimaryVal = document.getElementById('boxLotPrimaryValue');
  const boxPrimaryMeta = document.getElementById('boxLotPrimaryMeta');
  if (boxRec && boxPrimary) {
    boxPrimary.style.display = 'block';
    if (boxPrimaryVal) boxPrimaryVal.textContent = boxRec.lot_no;
    if (boxPrimaryMeta) boxPrimaryMeta.textContent = `${boxRec.work_date || '-'} | ${boxRec.product_name || '-'} | ${boxRec.box_count || 0}box × ${boxRec.qty_per_box || 0}ea | 거래처: ${boxRec.customer || '-'}`;
  } else if (boxPrimary) {
    boxPrimary.style.display = 'none';
  }

  // 헤더
  const badge = document.getElementById('traceLotBadge');
  const meta = document.getElementById('traceResultMeta');
  if (badge) badge.textContent = inputLot;
  if (meta) {
    const basisLabel = { box: '박스포장 기준', btl: '병포장 기준', ext: '추출 기준', grind: '분쇄 기준', roast: '로스팅 기준', raw: '생두입고 기준' };
    meta.innerHTML = `<span style="color:#2C5F2E;font-weight:700">${basisLabel[traceBasis] || '역추적'}</span> | 조회일시: ${new Date().toLocaleString('ko-KR')}`;
  }

  // 타임라인 (생두 → 로스팅 → 분쇄 → 추출 → 병포장 → 박스포장 순서로 표시)
  const steps = [
    {
      label: '생두 입고', icon: 'fa-box-open', dotClass: 'dot-raw', data: rawRec, color: '#D4A017',
      info: rawRec ? `${rawRec.item_name || '-'} (${rawRec.country_of_origin || '-'})` : null,
      extraInfo: rawRecs && rawRecs.length > 1 ? `블랜딩 ${rawRecs.length}종: ${rawRecs.map(r => r.item_name).join(', ')}` : null,
      meta: rawRec ? [
        { icon: 'fa-calendar', text: rawRec.receive_date || '-' },
        { icon: 'fa-weight', text: `${numFormat(rawRec.receive_qty, 2)} ${rawRec.unit || 'kg'}` },
        { icon: 'fa-globe', text: rawRec.country_of_origin || '-' },
        { icon: 'fa-check-circle', text: rawRec.quality_status || '-' },
      ] : []
    },
    {
      label: '로스팅', icon: 'fa-fire', dotClass: 'dot-roast', data: roastRec, color: '#e17055',
      info: roastRec ? `${roastRec.product_name || '-'} | ${roastRec.roast_level || '-'}` : null,
      meta: roastRec ? [
        { icon: 'fa-calendar', text: roastRec.work_date || '-' },
        { icon: 'fa-weight', text: `${numFormat(roastRec.raw_qty_in, 2)}kg → ${numFormat(roastRec.roasted_qty, 2)}kg` },
        { icon: 'fa-percentage', text: `수율 ${roastRec.yield_rate || 0}%` },
        { icon: 'fa-thermometer-half', text: `${roastRec.roast_temp || '-'}℃` },
      ] : []
    },
    {
      label: '분쇄', icon: 'fa-cog', dotClass: 'dot-grind', data: grindRec, color: '#6c5ce7',
      info: grindRec ? grindRec.product_name : null,
      meta: grindRec ? [
        { icon: 'fa-calendar', text: grindRec.work_date || '-' },
        { icon: 'fa-weight', text: `${numFormat(grindRec.input_qty, 2)}kg → ${numFormat(grindRec.ground_qty, 2)}kg` },
        { icon: 'fa-percentage', text: `수율 ${grindRec.yield_rate || 0}%` },
        { icon: 'fa-sliders-h', text: grindRec.grind_size || '-' },
      ] : []
    },
    {
      label: '추출', icon: 'fa-tint', dotClass: 'dot-extract', data: extRec, color: '#3498db',
      info: extRec ? extRec.product_name : null,
      meta: extRec ? [
        { icon: 'fa-calendar', text: extRec.work_date || '-' },
        { icon: 'fa-coffee', text: `커피 ${numFormat(extRec.coffee_input_qty, 2)}kg + 물 ${numFormat(extRec.water_input_qty, 2)}L → ${numFormat(extRec.extract_qty, 2)}L` },
        { icon: 'fa-clock', text: `추출시간 ${extRec.extract_duration || '-'}h` },
        { icon: 'fa-vials', text: `Brix ${extRec.brix || '-'}°` },
      ] : []
    },
    {
      label: '병 포장', icon: 'fa-wine-bottle', dotClass: 'dot-bottle', data: btlRec, color: '#1abc9c',
      info: btlRec ? btlRec.product_name : null,
      meta: btlRec ? [
        { icon: 'fa-calendar', text: btlRec.work_date || '-' },
        { icon: 'fa-flask', text: `${btlRec.fill_volume || '-'}mL × ${numFormat(btlRec.actual_qty, 0)}병` },
        { icon: 'fa-calendar-times', text: `소비기한: ${btlRec.expiry_date || '-'}` },
        { icon: 'fa-tag', text: `라벨: ${btlRec.label_applied ? '부착완료' : '미부착'}` },
      ] : []
    },
    {
      label: '박스 포장 (완제품)', icon: 'fa-boxes', dotClass: 'dot-box', data: boxRec, color: '#27ae60',
      info: boxRec ? boxRec.product_name : null,
      highlight: true,
      meta: boxRec ? [
        { icon: 'fa-calendar', text: boxRec.work_date || '-' },
        { icon: 'fa-box', text: `${numFormat(boxRec.qty_per_box, 0)}ea × ${numFormat(boxRec.box_count, 0)}box` },
        { icon: 'fa-truck', text: `거래처: ${boxRec.customer || '-'}` },
        { icon: 'fa-shipping-fast', text: `출고: ${boxRec.actual_ship_date || boxRec.scheduled_ship_date || '미정'}` },
      ] : []
    },
  ];

  const timeline = document.getElementById('traceTimeline');
  if (timeline) {
    timeline.innerHTML = steps.map(step => `
      <div class="timeline-item">
        <div class="timeline-dot ${step.dotClass} ${!step.data ? 'dot-empty' : ''}" style="${step.highlight && step.data ? 'box-shadow:0 0 0 4px rgba(39,174,96,0.3);width:48px;height:48px;font-size:20px' : ''}">
          <i class="fas ${step.icon}"></i>
        </div>
        <div class="timeline-content ${step.data ? 'active' : 'empty'}" style="${step.highlight && step.data ? 'border:2px solid #27ae60;background:#f0fdf4' : ''}">
          <div class="timeline-step-title">
            ${step.label}
            ${step.highlight ? '<span style="font-size:10px;background:#27ae60;color:#fff;border-radius:4px;padding:1px 6px">★ 추적 기준</span>' : ''}
            ${step.data ? '<span class="badge badge-success" style="margin-left:4px;font-size:10px">완료</span>' : '<span class="badge badge-warning" style="margin-left:4px;font-size:10px">미등록</span>'}
          </div>
          ${step.data ? `
            <div class="timeline-lot-no">${step.data.lot_no || '-'}</div>
            <div class="timeline-main-info">${step.info || '-'}</div>
            ${step.extraInfo ? `<div style="font-size:11px;color:#e67e22;font-weight:700;margin-bottom:4px"><i class="fas fa-layer-group"></i> ${step.extraInfo}</div>` : ''}
            <div class="timeline-meta-row">
              ${step.meta.map(m => `<span class="timeline-meta-item"><i class="fas ${m.icon}"></i>${m.text}</span>`).join('')}
              <span class="timeline-meta-item" style="color:${qualityColor(step.data.quality_result)}">
                <i class="fas fa-check-circle"></i>${step.data.quality_result || step.data.quality_status || '-'}
              </span>
            </div>
          ` : '<div style="font-size:12px;color:#aaa;padding:4px 0">이 단계의 생산 기록이 없습니다.</div>'}
        </div>
      </div>
    `).join('');
  }

  // 블랜딩 생두 복수 표시
  if (rawRecs && rawRecs.length > 1) {
    const blendSection = document.createElement('div');
    blendSection.style.cssText = 'background:#fff3cd;border:1px solid #ffc107;border-radius:10px;padding:12px 16px;margin-bottom:16px';
    blendSection.innerHTML = `<div style="font-size:13px;font-weight:700;color:#856404;margin-bottom:8px"><i class="fas fa-layer-group"></i> 블랜딩 생두 구성 (${rawRecs.length}종)</div>
      ${rawRecs.map((r, i) => `<div style="font-size:12px;padding:4px 0;border-bottom:1px solid rgba(255,193,7,0.3)">
        <span style="font-family:monospace;color:#2C5F2E;font-weight:700">${r.lot_no}</span>
        <span style="margin-left:8px">${r.item_name || '-'}</span>
        <span style="margin-left:8px;color:#888">${r.country_of_origin || '-'}</span>
        <span style="margin-left:8px;color:#27ae60;font-weight:700">${numFormat(r.receive_qty, 2)} ${r.unit || 'kg'}</span>
      </div>`).join('')}`;
    const details = document.getElementById('traceDetails');
    if (details) details.prepend(blendSection);
  }

  // 상세 정보 카드
  const detailCards = [
    rawRec ? buildDetailCard('생두 입고 정보', 'fa-box-open', '#D4A017', rawRec, [
      ['Lot No', rawRec.lot_no], ['품목명', rawRec.item_name], ['품목코드', rawRec.item_code || '-'],
      ['거래유형', rawRec.transaction_type], ['입고일자', rawRec.receive_date],
      ['수량', `${numFormat(rawRec.receive_qty, 2)} ${rawRec.unit || ''}`],
      ['잔량', `${numFormat(rawRec.balance, 2)} ${rawRec.unit || ''}`],
      ['공급업체', rawRec.supplier || '-'], ['원산지', rawRec.country_of_origin || '-'],
      ['소비기한', rawRec.expiry_date || '-'], ['보관위치', rawRec.storage_location || '-'],
      ['품질상태', rawRec.quality_status || '-'], ['검수자', rawRec.inspector || '-'],
    ]) : null,
    roastRec ? buildDetailCard('로스팅 정보', 'fa-fire', '#e17055', roastRec, [
      ['Lot No', roastRec.lot_no], ['작업일자', roastRec.work_date],
      ['생두 Lot #1', roastRec.raw_lot_1 || '-'],
      ['생두 Lot #2', roastRec.raw_lot_2 || '-'],
      ['생두 Lot #3', roastRec.raw_lot_3 || '-'],
      ['투입량', `${numFormat(roastRec.raw_qty_in, 2)} kg`],
      ['완료량', `${numFormat(roastRec.roasted_qty, 2)} kg`],
      ['수율', `${roastRec.yield_rate || 0}%`],
      ['온도', `${roastRec.roast_temp || '-'}℃`],
      ['레벨', roastRec.roast_level || '-'],
      ['기계', roastRec.roasting_machine || '-'],
      ['작업자', roastRec.worker || '-'],
      ['품질', roastRec.quality_result || '-'],
    ]) : null,
    grindRec ? buildDetailCard('분쇄 정보', 'fa-cog', '#6c5ce7', grindRec, [
      ['Lot No', grindRec.lot_no], ['작업일자', grindRec.work_date],
      ['로스팅 Lot', grindRec.roast_lot_no || '-'],
      ['투입량', `${numFormat(grindRec.input_qty, 2)} kg`],
      ['완료량', `${numFormat(grindRec.ground_qty, 2)} kg`],
      ['수율', `${grindRec.yield_rate || 0}%`],
      ['분쇄도', grindRec.grind_size || '-'],
      ['기계', grindRec.grinder_machine || '-'],
      ['작업자', grindRec.worker || '-'],
      ['품질', grindRec.quality_result || '-'],
    ]) : null,
    extRec ? buildDetailCard('추출 정보', 'fa-tint', '#3498db', extRec, [
      ['Lot No', extRec.lot_no], ['작업일자', extRec.work_date],
      ['분쇄 Lot', extRec.grind_lot_no || '-'],
      ['커피 투입', `${numFormat(extRec.coffee_input_qty, 2)} kg`],
      ['물 투입', `${numFormat(extRec.water_input_qty, 2)} L`],
      ['추출량', `${numFormat(extRec.extract_qty, 2)} L`],
      ['수율', `${extRec.yield_rate || 0}%`],
      ['추출시간', `${extRec.extract_duration || '-'}h`],
      ['온도', `${extRec.extract_temp || '-'}℃`],
      ['Brix', `${extRec.brix || '-'}°`],
      ['장비', extRec.extract_equipment || '-'],
      ['작업자', extRec.worker || '-'],
      ['품질', extRec.quality_result || '-'],
    ]) : null,
    btlRec ? buildDetailCard('병 포장 정보', 'fa-wine-bottle', '#1abc9c', btlRec, [
      ['Lot No', btlRec.lot_no], ['작업일자', btlRec.work_date],
      ['추출 Lot', btlRec.extract_lot_no || '-'],
      ['병 자재 Lot', btlRec.bottle_lot_no || '-'],
      ['캡/뚜껑 Lot', btlRec.cap_lot_no || '-'],
      ['주입량', `${numFormat(btlRec.fill_qty, 2)} L`],
      ['용량', `${btlRec.fill_volume || '-'} mL`],
      ['완성 수', `${numFormat(btlRec.bottle_count, 0)} ea`],
      ['불량 수', `${numFormat(btlRec.defect_count, 0)} ea`],
      ['실 수량', `${numFormat(btlRec.actual_qty, 0)} ea`],
      ['소비기한', btlRec.expiry_date || '-'],
      ['라벨', btlRec.label_applied ? '부착완료' : '미부착'],
      ['작업자', btlRec.worker || '-'],
      ['품질', btlRec.quality_result || '-'],
    ]) : null,
    boxRec ? buildDetailCard('박스 포장/출고 정보 ★', 'fa-boxes', '#27ae60', boxRec, [
      ['Lot No', boxRec.lot_no], ['작업일자', boxRec.work_date],
      ['병 포장 Lot', boxRec.bottle_lot_no || '-'],
      ['제품명', boxRec.product_name || '-'],
      ['입수(ea/box)', `${numFormat(boxRec.qty_per_box, 0)} ea`],
      ['박스 수', `${numFormat(boxRec.box_count, 0)} box`],
      ['총 병 수', `${numFormat(boxRec.total_bottle_count, 0)} ea`],
      ['보관위치', boxRec.storage_location || '-'],
      ['거래처', boxRec.customer || '-'],
      ['출고예정일', boxRec.scheduled_ship_date || '-'],
      ['실제출고일', boxRec.actual_ship_date || '-'],
      ['출고량', `${numFormat(boxRec.shipped_box_count, 0)} box`],
      ['작업자', boxRec.worker || '-'],
      ['품질', boxRec.quality_result || '-'],
    ]) : null,
  ].filter(Boolean);

  const detailContainer = document.getElementById('traceDetails');
  if (detailContainer && detailCards.length) {
    const existing = detailContainer.querySelector('.trace-details-grid');
    const grid = document.createElement('div');
    grid.className = 'trace-details-grid';
    grid.innerHTML = detailCards.join('');
    if (existing) {
      detailContainer.replaceChild(grid, existing);
    } else {
      detailContainer.innerHTML = `<h3 class="section-title" style="margin-bottom:16px"><i class="fas fa-info-circle"></i> 공정별 상세 정보</h3>`;
      detailContainer.appendChild(grid);
    }
  }
}

function buildDetailCard(title, icon, color, data, rows) {
  return `
    <div class="trace-detail-card">
      <div class="trace-detail-header" style="background:${color}">
        <i class="fas ${icon}"></i> ${title}
      </div>
      <div class="trace-detail-body">
        ${rows.filter(([, v]) => v && v !== '-').map(([label, value]) => `
          <div class="detail-row">
            <span class="detail-label">${label}</span>
            <span class="detail-value">${value || '-'}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function qualityColor(q) {
  if (q === '적합' || q === '합격') return '#27ae60';
  if (q === '부적합' || q === '불합격') return '#e74c3c';
  if (q === '재작업' || q === '특채') return '#f39c12';
  return '#888';
}

function numFormat(v, d = 0) {
  const n = parseFloat(v);
  if (isNaN(n)) return '-';
  return n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
