// =====================================================
// 온라인몰 판매 관리 JS — 라이프컬처
// 필드: db_no, order_no, invoice_no, company, product_name,
//       qty, channel, payment, settlement, supply_price,
//       delivery_fee, work_fee, box_fee, margin, margin_rate, remarks
// =====================================================

let allSales = [];
let archiveSales = []; // 과거 데이터 저장용
let filteredSales = [];
let currentPage = 1;
const pageSize = 50;
let editingId = null;
let isArchiveLoaded = false;
let _salesProductMasterCache = null; // 제품마스터 캐시 (제품명 datalist용)

// 기간 선택 필터 (연도/월)
let periodYear = '';  // '' = 전체, '2026' 등
let periodMonth = ''; // '' = 전체, '01'~'12'

// 샘플/샘플출고 판별 헬퍼
function isSampleRow(s) {
  const prod = String(s.product_name || '').toLowerCase();
  const ch = String(s.channel || '').toLowerCase();
  return prod.includes('샘플') || ch.includes('샘플');
}

// ===========================
// 초기화
// ===========================
document.addEventListener('DOMContentLoaded', () => {
  loadSales();

  // 아카이브 불러오기 버튼
  const loadArchiveBtn = document.getElementById('loadArchiveBtn');
  if (loadArchiveBtn) loadArchiveBtn.addEventListener('click', loadArchiveData);

  // 필터 버튼
  const applyBtn = document.getElementById('applyFilterBtn');
  if (applyBtn) applyBtn.addEventListener('click', applyFilter);
  const resetBtn = document.getElementById('resetFilterBtn');
  if (resetBtn) resetBtn.addEventListener('click', resetFilter);

  // 검색 실시간
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.addEventListener('input', applyFilter);

  // 필터 드롭다운 즉시 적용
  ['filterChannel', 'filterCompany', 'filterProduct', 'filterDateFrom', 'filterDateTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', applyFilter);
  });

  // 신규 등록 버튼
  const addBtn = document.getElementById('addSalesBtn');
  if (addBtn) addBtn.addEventListener('click', openNewModal);

  // 엑셀 다운로드
  const exportBtn = document.getElementById('exportExcelBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportToExcel);

  // 인쇄
  const printBtn = document.getElementById('printBtn');
  if (printBtn) printBtn.addEventListener('click', printData);

  // 샘플 엑셀
  const sampleBtn = document.getElementById('sampleExcelBtn');
  if (sampleBtn) sampleBtn.addEventListener('click', downloadSampleExcel);

  // 모달
  const closeBtn = document.getElementById('modalCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  const cancelBtn = document.getElementById('modalCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  const form = document.getElementById('salesForm');
  if (form) form.addEventListener('submit', handleSubmit);

  // 마진 자동계산
  ['f_settlement', 'f_supply', 'f_delivery', 'f_work', 'f_box'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', calcMargin);
  });

  // 더보기 메뉴
  setupMoreMenu();

  // 선택 삭제 버튼
  const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
  if (deleteSelectedBtn) deleteSelectedBtn.addEventListener('click', deleteSelectedData);

  // 전체 삭제 버튼 (직접 노출)
  const deleteAllRawBtn = document.getElementById('deleteAllRawBtn');
  if (deleteAllRawBtn) deleteAllRawBtn.addEventListener('click', deleteAllRawData);

  // 엑셀 가져오기 버튼
  const importExcelBtnTop = document.getElementById('importExcelBtn');
  if (importExcelBtnTop) importExcelBtnTop.addEventListener('click', openImportModal);

  // 모달 배경 클릭
  const modal = document.getElementById('salesModal');
  if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // 기간 선택 초기화 (연도 옵션 동적 생성)
  initPeriodFilter();
});

// ===========================
// 마진 자동계산
// ===========================
function calcMargin() {
  const settlement = parseFloat(document.getElementById('f_settlement')?.value) || 0;
  const supply = parseFloat(document.getElementById('f_supply')?.value) || 0;
  const delivery = parseFloat(document.getElementById('f_delivery')?.value) || 0;
  const work = parseFloat(document.getElementById('f_work')?.value) || 0;
  const box = parseFloat(document.getElementById('f_box')?.value) || 0;
  const margin = settlement - supply - delivery - work - box;
  const marginRate = settlement > 0 ? ((margin / settlement) * 100).toFixed(1) : '0.0';
  const mEl = document.getElementById('f_margin');
  const mrEl = document.getElementById('f_margin_rate');
  if (mEl) mEl.value = margin;
  if (mrEl) mrEl.value = marginRate + '%';
}

// ===========================
// 데이터 로드
// ===========================
async function loadSales() {
  const tb = document.getElementById('salesTableBody');
  if (tb) tb.innerHTML = `<tr><td colspan="14" style="text-align:center;padding:60px;color:#999">
    <i class="fas fa-spinner fa-spin"></i> 오늘 데이터 로딩 중...</td></tr>`;
  
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const rawData = await apiGetAll('sales');
    
    // 유효한 데이터만 필터링 (업체명, 제품명, 주문번호 중 하나라도 있어야 함)
    // 입력하지 않았는데 1건이 보이는 현상 방지
    const data = rawData.filter(s => s.company || s.product_name || s.order_no);
    
    // 오늘 날짜 데이터와 과거 데이터 분리
    allSales = data.filter(s => (s.sale_date || '').startsWith(todayStr));
    archiveSales = data.filter(s => !(s.sale_date || '').startsWith(todayStr));
    
    allSales.sort((a, b) => (b.db_no || 0) - (a.db_no || 0));
    archiveSales.sort((a, b) => (b.db_no || 0) - (a.db_no || 0));

    buildFilterOptions();
    
    // 초기 로드 시 날짜 필터가 이미 설정되어 있을 수 있으므로 체크
    const dateFrom = document.getElementById('filterDateFrom')?.value || '';
    const dateTo = document.getElementById('filterDateTo')?.value || '';
    if (dateFrom || dateTo) {
      // 날짜 필터가 있으면 자동으로 아카이브 포함
      allSales = [...allSales, ...archiveSales];
      allSales.sort((a, b) => (b.db_no || 0) - (a.db_no || 0));
      isArchiveLoaded = true;
      const info = document.getElementById('archiveInfo');
      if (info) info.style.display = 'none';
    }

    // 연도 옵션 갱신 (전체 데이터 기준)
    buildPeriodYearOptions([...allSales, ...archiveSales]);
    applyPeriodFilter();
  } catch (e) {
    console.error('[sales] 로드 실패:', e);
    if (tb) tb.innerHTML = `<tr><td colspan="14" style="text-align:center;padding:60px;color:#999">
      <i class="fas fa-exclamation-circle"></i> 데이터 로드 실패: ${e.message}</td></tr>`;
  }
}

async function loadArchiveData() {
  const btn = document.getElementById('loadArchiveBtn');
  const info = document.getElementById('archiveInfo');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 아카이브 로딩 중...';
  }

  try {
    // 이미 loadSales에서 모든 데이터를 가져와 archiveSales에 분리해두었으므로
    // UI상에서 합치기만 하면 됨 (실제 서버 부하가 클 경우 쿼리 파라미터로 날짜 제한 필요)
    allSales = [...allSales, ...archiveSales];
    allSales.sort((a, b) => (b.db_no || 0) - (a.db_no || 0));
    
    isArchiveLoaded = true;
    if (info) info.style.display = 'none';
    
    buildFilterOptions();
    buildPeriodYearOptions(allSales);
    applyPeriodFilter();
    showToast('과거 데이터를 성공적으로 불러왔습니다.', 'success');
  } catch (e) {
    console.error('[archive] 로드 실패:', e);
    showToast('과거 데이터 로드 중 오류가 발생했습니다.', 'danger');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-archive"></i> 과거 데이터 불러오기';
    }
  }
}

// ===========================
// 필터 옵션 빌드
// ===========================
function buildFilterOptions() {
  // 아카이브 로드 여부와 관계없이 전체 데이터에서 옵션 추출
  const combined = [...allSales, ...archiveSales];
  const channels = [...new Set(combined.map(s => s.channel).filter(Boolean))].sort();
  const companies = [...new Set(combined.map(s => s.company).filter(Boolean))].sort();
  const products = [...new Set(combined.map(s => s.product_name).filter(Boolean))].sort();

  const chSel = document.getElementById('filterChannel');
  if (chSel) {
    chSel.innerHTML = '<option value="">전체 채널</option>' +
      channels.map(c => `<option value="${c}">${c}</option>`).join('');
  }
  const coSel = document.getElementById('filterCompany');
  if (coSel) {
    coSel.innerHTML = '<option value="">전체 업체</option>' +
      companies.map(c => `<option value="${c}">${c}</option>`).join('');
  }
  const prSel = document.getElementById('filterProduct');
  if (prSel) {
    prSel.innerHTML = '<option value="">전체 제품</option>' +
      products.map(p => `<option value="${p}">${p}</option>`).join('');
  }

  // datalist 업데이트
  const chList = document.getElementById('channelList');
  if (chList) chList.innerHTML = channels.map(c => `<option value="${c}">`).join('');

  // productList datalist: 제품마스터 제품명 + 기존 판매 데이터 제품명 합집합
  const prList = document.getElementById('productList');
  if (prList) {
    // 제품마스터 비동기 로드 (캐시 없으면 신규 요청)
    if (!_salesProductMasterCache) {
      apiGetAll('products').then(masterList => {
        _salesProductMasterCache = masterList || [];
        const masterNames = _salesProductMasterCache.map(p => p.product_name).filter(Boolean);
        const allNames = [...new Set([...masterNames, ...products])].sort();
        prList.innerHTML = allNames.map(p => `<option value="${p}">`).join('');
      }).catch(() => {
        prList.innerHTML = products.map(p => `<option value="${p}">`).join('');
      });
    } else {
      const masterNames = _salesProductMasterCache.map(p => p.product_name).filter(Boolean);
      const allNames = [...new Set([...masterNames, ...products])].sort();
      prList.innerHTML = allNames.map(p => `<option value="${p}">`).join('');
    }
  }
}

// ===========================
// 필터 적용
// ===========================
function applyFilter() {
  const dateFrom = document.getElementById('filterDateFrom')?.value || '';
  const dateTo = document.getElementById('filterDateTo')?.value || '';
  const channel = document.getElementById('filterChannel')?.value || '';
  const company = document.getElementById('filterCompany')?.value || '';
  const product = document.getElementById('filterProduct')?.value || '';
  const search = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();

  // 검색어가 있거나 날짜 필터가 있는 경우, 아카이브가 로드되지 않았다면 자동으로 합쳐서 검색
  let sourceData = allSales;
  const isSearching = search || dateFrom || dateTo || channel || company || product;
  
  // 날짜 필터가 있거나 검색어가 있으면 자동으로 아카이브 로드
  if (isSearching && !isArchiveLoaded && archiveSales.length > 0) {
    sourceData = [...allSales, ...archiveSales];
    // UI 업데이트 (안내 문구 숨기기)
    const info = document.getElementById('archiveInfo');
    if (info) info.style.display = 'none';
    isArchiveLoaded = true;
    allSales = sourceData; // 검색 시 전체 데이터를 allSales로 승격
    allSales.sort((a, b) => (b.db_no || 0) - (a.db_no || 0));
  }

  filteredSales = sourceData.filter(s => {
    if (dateFrom && s.sale_date && s.sale_date < dateFrom) return false;
    if (dateTo && s.sale_date && s.sale_date > dateTo) return false;
    if (channel && s.channel !== channel) return false;
    if (company && s.company !== company) return false;
    if (product && s.product_name !== product) return false;
    if (search) {
      const haystack = [s.order_no, s.invoice_no, s.product_name, s.company, s.channel, s.remarks]
        .join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  currentPage = 1;
  renderKpi(filteredSales);
  renderTable();
  renderPagination();
  updateResultCount();
  updatePrintSubtitle();
}

function resetFilter() {
  ['filterDateFrom', 'filterDateTo', 'searchInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['filterChannel', 'filterCompany', 'filterProduct'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  applyFilter();
}

function updateResultCount() {
  const el = document.getElementById('resultCount');
  if (el) el.textContent = `조회 결과: ${filteredSales.length.toLocaleString()}건 (전체 ${allSales.length.toLocaleString()}건)`;
}

function updatePrintSubtitle() {
  const el = document.getElementById('printSubtitle');
  if (!el) return;
  const from = document.getElementById('filterDateFrom')?.value || '';
  const to = document.getElementById('filterDateTo')?.value || '';
  const channel = document.getElementById('filterChannel')?.value || '';
  const company = document.getElementById('filterCompany')?.value || '';
  const product = document.getElementById('filterProduct')?.value || '';
  const parts = [];
  if (from || to) parts.push(`기간: ${from || '전체'} ~ ${to || '전체'}`);
  if (channel) parts.push(`채널: ${channel}`);
  if (company) parts.push(`업체: ${company}`);
  if (product) parts.push(`제품: ${product}`);
  parts.push(`총 ${filteredSales.length}건`);
  el.textContent = parts.join(' | ');
}

// ===========================
// 매출 그래프
// ===========================
let salesChartInstance = null;
let chartMode = 'month'; // 'day' | 'week' | 'month'
let chartCollapsed = false;

function setChartMode(mode) {
  chartMode = mode;
  // 토글 버튼 활성 상태
  ['day', 'week', 'month'].forEach(m => {
    const btn = document.getElementById('chartMode' + m.charAt(0).toUpperCase() + m.slice(1));
    if (btn) btn.classList.toggle('active', m === mode);
  });
  // 기간 필터 적용된 데이터로 차트 렌더링
  const chartData = getPeriodFilteredData();
  renderSalesChart(chartData);
}

function toggleChartCollapse() {
  chartCollapsed = !chartCollapsed;
  const body = document.getElementById('chartBody');
  const icon = document.getElementById('chartCollapseIcon');
  const text = document.getElementById('chartCollapseText');
  if (body) body.style.display = chartCollapsed ? 'none' : 'block';
  if (icon) { icon.className = chartCollapsed ? 'fas fa-chevron-down' : 'fas fa-chevron-up'; }
  if (text) text.textContent = chartCollapsed ? '펼치기' : '접어두기';
}

// 차트 키(날짜) 클릭 시 필터링
function filterByChartKey(key) {
  const dateFrom = document.getElementById('filterDateFrom');
  const dateTo = document.getElementById('filterDateTo');
  
  if (chartMode === 'day') {
    if (dateFrom) dateFrom.value = key;
    if (dateTo) dateTo.value = key;
  } else if (chartMode === 'month') {
    // 해당 월의 시작일과 종료일 계산
    const [y, m] = key.split('-');
    const lastDay = new Date(y, m, 0).getDate();
    if (dateFrom) dateFrom.value = `${y}-${m}-01`;
    if (dateTo) dateTo.value = `${y}-${m}-${lastDay.toString().padStart(2, '0')}`;
  } else if (chartMode === 'week') {
    // 해당 주의 시작일(월)과 종료일(일) 계산
    const d = new Date(key);
    const last = new Date(key);
    last.setDate(d.getDate() + 6);
    if (dateFrom) dateFrom.value = key;
    if (dateTo) dateTo.value = last.toISOString().slice(0, 10);
  }
  
  applyFilter();
  showToast(`${key} 기간의 데이터를 필터링했습니다.`, 'info');
}

function renderSalesChart(data) {
  const canvas = document.getElementById('salesChart');
  if (!canvas) return;

  // 데이터 집계 (샘플 제외 - 매출 차트에는 실제 매출만 표시)
  const grouped = {};
  data.filter(s => !isSampleRow(s)).forEach(s => {
    const dateStr = s.sale_date || s.createdAt || '';
    if (!dateStr) return;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return;
    let key = '';
    if (chartMode === 'day') {
      key = dateStr.slice(0, 10); // YYYY-MM-DD
    } else if (chartMode === 'week') {
      // 해당 주의 월요일 (ISO 주차)
      const day = d.getDay(); // 0=일, 1=월...
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(d.setDate(diff));
      key = mon.toISOString().slice(0, 10);
    } else {
      key = dateStr.slice(0, 7); // YYYY-MM
    }
    grouped[key] = (grouped[key] || 0) + (parseFloat(s.payment) || 0);
  });

  // 키 정렬
  const labels = Object.keys(grouped).sort();
  const values = labels.map(k => grouped[k]);

  // 레이블 포맷팅
  const fmtLabel = (k) => {
    if (chartMode === 'month') {
      const [y, m] = k.split('-');
      return `${parseInt(m)}월`;
    } else if (chartMode === 'week') {
      const d = new Date(k);
      return `${d.getMonth()+1}/${d.getDate()}주`;
    } else {
      return k.slice(5); // MM-DD
    }
  };

  // 기존 차트 제거
  if (salesChartInstance) { salesChartInstance.destroy(); salesChartInstance = null; }

  salesChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels.map(fmtLabel),
      datasets: [{
        label: '매출액',
        data: values,
        backgroundColor: 'rgba(44, 95, 46, 0.75)',
        borderColor: '#2C5F2E',
        borderWidth: 1,
        borderRadius: 4,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (e, elements) => {
        if (elements.length > 0) {
          const index = elements[0].index;
          const key = labels[index];
          filterByChartKey(key);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v >= 100000000) return `매출: ${(v/100000000).toFixed(2)}억원`;
              if (v >= 10000) return `매출: ${(v/10000).toFixed(0)}만원`;
              return `매출: ${v.toLocaleString()}원`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 }, color: '#666' }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f0f0f0' },
          ticks: {
            font: { size: 11 },
            color: '#666',
            callback: (v) => {
              if (v >= 100000000) return (v/100000000).toFixed(1) + '억';
              if (v >= 10000) return (v/10000).toFixed(0) + '만';
              return v.toLocaleString();
            }
          }
        }
      }
    }
  });
}

// ===========================
// KPI 렌더링
// ===========================
function renderKpi(data) {
  // KPI 집계에서 샘플 항목 제외 (테이블에는 표시하되 매출 통계에서는 제외)
  const salesData = data.filter(r => !isSampleRow(r));
  const sampleCount = data.length - salesData.length;
  const count = salesData.length;
  const totalPayment = salesData.reduce((s, r) => s + (parseFloat(r.payment) || 0), 0);
  const totalSettlement = salesData.reduce((s, r) => s + (parseFloat(r.settlement) || 0), 0);
  const totalMargin = salesData.reduce((s, r) => s + (parseFloat(r.margin) || 0), 0);
  const avgMarginRate = totalSettlement > 0 ? ((totalMargin / totalSettlement) * 100).toFixed(1) : '0.0';

  const fmt = (n) => {
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '억';
    if (n >= 10000) return Math.round(n / 10000).toLocaleString('ko-KR') + '만';
    return n.toLocaleString('ko-KR');
  };

  setKpi('kpiCount', count.toLocaleString());
  setKpi('kpiPayment', fmt(Math.round(totalPayment)));
  setKpi('kpiSettlement', fmt(Math.round(totalSettlement)));
  setKpi('kpiMargin', fmt(Math.round(totalMargin)));
  setKpi('kpiMarginRate', avgMarginRate);
}

function setKpi(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ===========================
// 기간 선택 필터 (연도/월)
// ===========================

/** 연도 옵션을 데이터에서 동적 생성 */
function buildPeriodYearOptions(data) {
  const yearSel = document.getElementById('periodYear');
  if (!yearSel) return;
  const years = [...new Set(
    data.map(s => (s.sale_date || '').slice(0, 4)).filter(y => /^\d{4}$/.test(y))
  )].sort((a, b) => b - a);
  const cur = yearSel.value;
  yearSel.innerHTML = '<option value="">전체</option>' +
    years.map(y => `<option value="${y}"${y === cur ? ' selected' : ''}>${y}년</option>`).join('');
}

/** 초기 초기화 - 현재 연도 자동 선택 */
function initPeriodFilter() {
  const yearSel = document.getElementById('periodYear');
  if (!yearSel) return;
  const thisYear = String(new Date().getFullYear());
  // 데이터 로드 전이라 옵션이 없으면 단순 초기화만
  periodYear = '';
  periodMonth = '';
}

/** 기간 필터 적용된 데이터 반환 (샘플 포함) */
function getPeriodFilteredData() {
  const combined = isArchiveLoaded ? allSales : [...allSales, ...archiveSales];
  if (!periodYear) return combined;
  return combined.filter(s => {
    const d = s.sale_date || '';
    if (!d.startsWith(periodYear)) return false;
    if (periodMonth && d.slice(5, 7) !== periodMonth) return false;
    return true;
  });
}

/** 기간 선택 변경 시 호출 */
function onPeriodChange() {
  const yearSel = document.getElementById('periodYear');
  const monthSel = document.getElementById('periodMonth');
  periodYear = yearSel?.value || '';
  periodMonth = monthSel?.value || '';

  // 월 선택시 연도가 없으면 자동으로 현재 연도 선택
  if (periodMonth && !periodYear) {
    const thisYear = String(new Date().getFullYear());
    periodYear = thisYear;
    if (yearSel) yearSel.value = thisYear;
  }

  // 아카이브 자동 로드 (periodYear가 설정된 경우)
  if (periodYear && !isArchiveLoaded) {
    allSales = [...allSales, ...archiveSales];
    allSales.sort((a, b) => (b.db_no || 0) - (a.db_no || 0));
    isArchiveLoaded = true;
    const info = document.getElementById('archiveInfo');
    if (info) info.style.display = 'none';
  }

  applyPeriodFilter();
}

/** 기간 필터 적용 후 차트 + KPI + 테이블 갱신 */
function applyPeriodFilter() {
  const data = getPeriodFilteredData();

  // 배지 텍스트 업데이트
  const mNames = ['','1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
  const badge = document.getElementById('periodBadge');
  let periodLabel = '전체 기간';
  if (!periodYear) periodLabel = '전체 기간';
  else if (!periodMonth) periodLabel = `${periodYear}년`;
  else periodLabel = `${periodYear}년 ${mNames[parseInt(periodMonth)]}`;
  if (badge) badge.textContent = periodLabel;

  // 차트 제목 동적 변경
  const chartTitle = document.querySelector('.chart-title');
  if (chartTitle) {
    chartTitle.innerHTML = `<i class="fas fa-chart-bar"></i> ${periodLabel} 매출액 추이`;
  }

  // 차트 렌더링
  renderSalesChart(data);

  // KPI 렌더링 (기간별 집계)
  renderKpi(data);

  // 테이블 필터: 기간 선택시 filterDateFrom/To 연동
  if (periodYear) {
    const dateFrom = document.getElementById('filterDateFrom');
    const dateTo = document.getElementById('filterDateTo');
    if (periodMonth) {
      const lastDay = new Date(parseInt(periodYear), parseInt(periodMonth), 0).getDate();
      if (dateFrom) dateFrom.value = `${periodYear}-${periodMonth}-01`;
      if (dateTo) dateTo.value = `${periodYear}-${periodMonth}-${String(lastDay).padStart(2, '0')}`;
    } else {
      if (dateFrom) dateFrom.value = `${periodYear}-01-01`;
      if (dateTo) dateTo.value = `${periodYear}-12-31`;
    }
    applyFilter();
  } else {
    // 전체 기간: 날짜 필터 초기화
    const dateFrom = document.getElementById('filterDateFrom');
    const dateTo = document.getElementById('filterDateTo');
    if (dateFrom) dateFrom.value = '';
    if (dateTo) dateTo.value = '';
    applyFilter();
  }
}

/** 기간 선택 전체 보기 초기화 */
function resetPeriod() {
  periodYear = '';
  periodMonth = '';
  const yearSel = document.getElementById('periodYear');
  const monthSel = document.getElementById('periodMonth');
  if (yearSel) yearSel.value = '';
  if (monthSel) monthSel.value = '';
  applyPeriodFilter();
}

// ===========================
// 테이블 렌더링
// ===========================
function renderTable() {
  const tb = document.getElementById('salesTableBody');
  if (!tb) return;

  const start = (currentPage - 1) * pageSize;
  const pageData = filteredSales.slice(start, start + pageSize);

  if (!pageData.length) {
    tb.innerHTML = `<tr><td colspan="14" style="text-align:center;padding:60px;color:#999">
      <i class="fas fa-inbox"></i> 조회된 데이터가 없습니다.</td></tr>`;
    return;
  }

  tb.innerHTML = pageData.map((s, i) => {
    const isSample = isSampleRow(s);
    const margin = parseFloat(s.margin) || 0;
    const marginRate = parseFloat(s.margin_rate) || 0;
    const marginClass = margin >= 0 ? 'margin-pos' : 'margin-neg';
    const marginRateStr = typeof s.margin_rate === 'string' && s.margin_rate.includes('%')
      ? s.margin_rate
      : (marginRate * 100).toFixed(1) + '%';
    // 샘플 행: 연한 배경 + 제품명/수량만 표시, 금액 컴럼은 '-'
    const rowStyle = isSample ? ' style="background:#f9f9f9;color:#999;font-style:italic"' : '';
    const sampleBadge = isSample ? ' <span style="background:#f0ad4e;color:#fff;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:600;font-style:normal">샘플</span>' : '';
    return `<tr data-id="${s.id}"${rowStyle}>
      <td class="center"><input type="checkbox" class="row-chk" data-id="${s.id}" style="cursor:pointer;width:15px;height:15px"></td>
      <td>${s.company || '-'}</td>
      <td>${s.product_name || '-'}${sampleBadge}</td>
      <td><span style="background:#e8f5e9;color:#1e8449;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${s.channel || '-'}</span></td>
      <td class="center">${s.qty || s.quantity || '-'}</td>
      <td class="num">${isSample ? '-' : numFmt(s.payment)}</td>
      <td class="num">${isSample ? '-' : numFmt(s.settlement)}</td>
      <td class="num">${isSample ? '-' : numFmt(s.supply_price)}</td>
      <td class="num">${isSample ? '-' : numFmt(s.delivery_fee)}</td>
      <td class="num">${isSample ? '-' : numFmt(s.work_fee)}</td>
      <td class="num">${isSample ? '-' : numFmt(s.box_fee)}</td>
      <td class="num ${marginClass}">${isSample ? '-' : numFmt(s.margin)}</td>
      <td class="center ${marginClass}">${isSample ? '-' : marginRateStr}</td>
      <td class="center">
        <button class="btn btn-secondary" style="padding:3px 8px;font-size:11px" onclick="openEditModal('${s.id}')">
          <i class="fas fa-edit"></i>
        </button>
      </td>
    </tr>`;
  }).join('');

  // 체크박스 이벤트 바인딩
  setupCheckboxEvents();
}

// ===========================
// 체크박스 선택 삭제
// ===========================
function setupCheckboxEvents() {
  // 전체 선택 체크박스
  const selectAllChk = document.getElementById('selectAllChk');
  if (selectAllChk) {
    selectAllChk.onchange = function() {
      document.querySelectorAll('.row-chk').forEach(chk => { chk.checked = this.checked; });
      updateDeleteSelectedBtn();
    };
  }

  // 개별 체크박스
  document.querySelectorAll('.row-chk').forEach(chk => {
    chk.onchange = function() {
      const all = document.querySelectorAll('.row-chk');
      const checked = document.querySelectorAll('.row-chk:checked');
      if (selectAllChk) selectAllChk.checked = all.length === checked.length;
      updateDeleteSelectedBtn();
    };
  });
}

function updateDeleteSelectedBtn() {
  const checked = document.querySelectorAll('.row-chk:checked');
  const btn = document.getElementById('deleteSelectedBtn');
  if (!btn) return;
  if (checked.length > 0) {
    btn.style.display = 'inline-flex';
    btn.textContent = '';
    btn.innerHTML = `<i class="fas fa-trash-alt"></i> 선택 삭제 (${checked.length}건)`;
  } else {
    btn.style.display = 'none';
  }
}

function deleteSelectedData() {
  const checked = document.querySelectorAll('.row-chk:checked');
  if (!checked.length) { showToast('삭제할 항목을 선택하세요.', 'error'); return; }
  const ids = Array.from(checked).map(chk => chk.dataset.id);
  showConfirm(`선택한 ${ids.length}건을 삭제하시겠습니까?<br><small style="color:#e74c3c">삭제 후 복구할 수 없습니다.</small>`, async () => {
    try {
      await apiBatchDelete('sales', ids, () => {});
      showToast(`✅ ${ids.length}건 삭제 완료`, 'success');
      // 선택 삭제 버튼 숨김
      const btn = document.getElementById('deleteSelectedBtn');
      if (btn) btn.style.display = 'none';
      // 전체선택 체크박스 해제
      const selectAllChk = document.getElementById('selectAllChk');
      if (selectAllChk) selectAllChk.checked = false;
      await loadSales();
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
    }
  });
}

function numFmt(v) {
  const n = parseFloat(v);
  if (isNaN(n) || v === null || v === undefined || v === '') return '-';
  return n.toLocaleString('ko-KR') + '원';
}

// ===========================
// 페이지네이션
// ===========================
function renderPagination() {
  const pg = document.getElementById('pagination');
  if (!pg) return;
  const totalPages = Math.ceil(filteredSales.length / pageSize);
  if (totalPages <= 1) { pg.innerHTML = ''; return; }

  let html = `<button class="page-btn" onclick="goPage(1)" ${currentPage===1?'disabled':''}>«</button>
    <button class="page-btn" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>‹</button>`;

  const range = 3;
  const start = Math.max(1, currentPage - range);
  const end = Math.min(totalPages, currentPage + range);
  if (start > 1) html += `<span style="padding:0 4px;color:#aaa">...</span>`;
  for (let p = start; p <= end; p++) {
    html += `<button class="page-btn ${p===currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`;
  }
  if (end < totalPages) html += `<span style="padding:0 4px;color:#aaa">...</span>`;

  html += `<button class="page-btn" onclick="goPage(${currentPage+1})" ${currentPage===totalPages?'disabled':''}>›</button>
    <button class="page-btn" onclick="goPage(${totalPages})" ${currentPage===totalPages?'disabled':''}>»</button>`;
  html += `<span style="font-size:12px;color:#888;margin-left:8px">${currentPage} / ${totalPages} 페이지</span>`;
  pg.innerHTML = html;
}

function goPage(p) {
  const totalPages = Math.ceil(filteredSales.length / pageSize);
  if (p < 1 || p > totalPages) return;
  currentPage = p;
  renderTable();
  renderPagination();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===========================
// 모달 - 신규 등록
// ===========================
function openNewModal() {
  editingId = null;
  const form = document.getElementById('salesForm');
  if (form) form.reset();
  // 판매일자 오늘 날짜 기본값
  const saleDateEl = document.getElementById('f_sale_date');
  if (saleDateEl) saleDateEl.value = new Date().toISOString().slice(0, 10);
  const titleEl = document.getElementById('modalTitle');
  if (titleEl) titleEl.textContent = '신규 판매기록 등록';
  const modal = document.getElementById('salesModal');
  if (modal) modal.classList.add('show');
}

// ===========================
// 모달 - 수정
// ===========================
function openEditModal(id) {
  const s = allSales.find(r => r.id === id);
  if (!s) return;
  editingId = id;

  const form = document.getElementById('salesForm');
  if (form) form.reset();

  const map = {
    f_sale_date: s.sale_date || new Date().toISOString().slice(0, 10),
    f_company: s.company,
    f_channel: s.channel,
    f_product: s.product_name,
    f_order_no: s.order_no,
    f_invoice_no: s.invoice_no,
    f_qty: s.qty || s.quantity,
    f_payment: s.payment,
    f_settlement: s.settlement,
    f_supply: s.supply_price,
    f_delivery: s.delivery_fee,
    f_work: s.work_fee,
    f_box: s.box_fee,
    f_margin: s.margin,
    f_margin_rate: typeof s.margin_rate === 'number'
      ? (s.margin_rate * 100).toFixed(1) + '%' : s.margin_rate,
    f_remarks: s.remarks,
  };
  Object.entries(map).forEach(([fid, val]) => {
    const el = document.getElementById(fid);
    if (el && val !== undefined && val !== null) el.value = val;
  });

  const titleEl = document.getElementById('modalTitle');
  if (titleEl) titleEl.textContent = '판매기록 수정';
  const modal = document.getElementById('salesModal');
  if (modal) modal.classList.add('show');
}

function closeModal() {
  const modal = document.getElementById('salesModal');
  if (modal) modal.classList.remove('show');
  editingId = null;
}

// ===========================
// 폼 제출
// ===========================
async function handleSubmit(e) {
  e.preventDefault();
  const settlement = parseFloat(document.getElementById('f_settlement')?.value) || 0;
  const supply = parseFloat(document.getElementById('f_supply')?.value) || 0;
  const delivery = parseFloat(document.getElementById('f_delivery')?.value) || 0;
  const work = parseFloat(document.getElementById('f_work')?.value) || 0;
  const box = parseFloat(document.getElementById('f_box')?.value) || 0;
  const margin = settlement - supply - delivery - work - box;
  const marginRate = settlement > 0 ? margin / settlement : 0;

  const data = {
    company: document.getElementById('f_company')?.value?.trim() || '',
    channel: document.getElementById('f_channel')?.value?.trim() || '',
    product_name: document.getElementById('f_product')?.value?.trim() || '',
    order_no: document.getElementById('f_order_no')?.value?.trim() || '',
    invoice_no: document.getElementById('f_invoice_no')?.value?.trim() || '',
    qty: parseInt(document.getElementById('f_qty')?.value) || 0,
    payment: parseFloat(document.getElementById('f_payment')?.value) || 0,
    settlement,
    supply_price: supply,
    delivery_fee: delivery,
    work_fee: work,
    box_fee: box,
    margin,
    margin_rate: marginRate,
    remarks: document.getElementById('f_remarks')?.value?.trim() || '',
    sale_date: document.getElementById('f_sale_date')?.value || new Date().toISOString().slice(0, 10),
  };

  if (!data.company) { showToast('업체명을 입력하세요.', 'warning'); return; }
  if (!data.channel) { showToast('쇼핑몰(채널)을 입력하세요.', 'warning'); return; }
  if (!data.product_name) { showToast('제품명을 입력하세요.', 'warning'); return; }
  if (!data.qty) { showToast('수량을 입력하세요.', 'warning'); return; }

  const submitBtn = document.querySelector('#salesForm button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }

  try {
    if (editingId) {
      await apiPut('sales', editingId, data);
      showToast('수정되었습니다.', 'success');
    } else {
      await apiPost('sales', data);
      showToast('등록되었습니다.', 'success');
    }
    closeModal();
    await loadSales();
  } catch (err) {
    showToast('저장 실패: ' + err.message, 'error');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-save"></i> 저장'; }
  }
}

// ===========================
// 삭제
// ===========================
async function deleteSale(id) {
  showConfirm('이 판매기록을 삭제하시겠습니까?', async () => {
    try {
      await apiDelete('sales', id);
      showToast('삭제되었습니다.', 'success');
      await loadSales();
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
    }
  });
}

// ===========================
// 엑셀 다운로드 (필터링된 데이터)
// ===========================
function exportToExcel() {
  if (!filteredSales.length) { showToast('다운로드할 데이터가 없습니다.', 'warning'); return; }
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리 로딩 중입니다. 잠시 후 다시 시도해주세요.', 'warning'); return; }

  const headers = ['DB번호', '주문번호', '송장번호', '업체명', '제품명', '쇼핑몰', '수량', '결제금액', '정산금액', '공급가', '택배비', '작업비', '포장박스', '마진', '마진율'];
  const rows = filteredSales.map(s => {
    const marginRate = typeof s.margin_rate === 'number'
      ? parseFloat((s.margin_rate * 100).toFixed(4))
      : parseFloat(String(s.margin_rate || '0').replace('%', '')) / 100;
    return [
      s.db_no || '',
      s.order_no || '',
      s.invoice_no || '',
      s.company || '',
      s.product_name || '',
      s.channel || '',
      s.qty || s.quantity || 0,
      parseFloat(s.payment) || 0,
      parseFloat(s.settlement) || 0,
      parseFloat(s.supply_price) || 0,
      parseFloat(s.delivery_fee) || 0,
      parseFloat(s.work_fee) || 0,
      parseFloat(s.box_fee) || 0,
      parseFloat(s.margin) || 0,
      marginRate,
    ];
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [10, 22, 16, 12, 28, 6, 14, 12, 12, 12, 8, 8, 8, 12, 8].map(w => ({ wch: w }));

  // 마진율 열 (O열, index 14) 퍼센트 포맷
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = 1; R <= range.e.r; R++) {
    const cell = ws[XLSX.utils.encode_cell({ r: R, c: 14 })];
    if (cell) cell.z = '0.00%';
  }

  XLSX.utils.book_append_sheet(wb, ws, '판매기록');
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;

  // 필터 조건을 파일명에 반영
  const channel = document.getElementById('filterChannel')?.value || '';
  const company = document.getElementById('filterCompany')?.value || '';
  const suffix = [channel, company].filter(Boolean).join('_');
  const filename = `라이프컬처_판매기록${suffix ? '_' + suffix : ''}_${dateStr}.xlsx`;

  XLSX.writeFile(wb, filename);
  showToast(`✅ 엑셀 다운로드 완료 (${filteredSales.length}건)`, 'success');
}

// ===========================
// 인쇄
// ===========================
function printData() {
  updatePrintSubtitle();
  window.print();
}

// ===========================
// 샘플 엑셀 다운로드
// ===========================
function downloadSampleExcel() {
  if (typeof XLSX === 'undefined') { showToast('라이브러리 로딩 중...', 'warning'); return; }
  const sample = [
    ['DB번호', '주문번호', '송장번호', '업체명', '제품명', '쇼핑몰', '수량', '결제금액', '정산금액', '공급가', '택배비', '작업비', '포장박스', '마진', '마진율'],
    [2172797636, '4432988326', '410392878700', '단하', '감동식탁 참기름 + 들기름', 'ESM지마켓', 1, 16920, 15823, 7540, 2800, 550, 0, 4933, 0.3117],
    [2172789918, '3446224279', '410392878814', '단하', '참기름', 'GS shop', 2, 15294, 14365, 7980, 2800, 550, 0, 3035, 0.1984],
    [2172782289, '251697828', '410392878744', '단하', '참기름', '베네피아', 2, 20900, 18180, 7980, 2800, 550, 0, 6850, 0.3278],
    [2172809854, '20260417849443', '410392888673', '담양한과', '전통 찹쌀 약과 40개', '신세계TV쇼핑', 1, 9900, 8415, 4050, 2800, 550, 0, 1015, 0.1206],
    [2172809918, '20260418395558', '410392877790', '담양한과', '미니 호박 약과 1kg', 'CJ온스타일', 1, 18000, 15300, 8500, 2800, 550, 0, 3450, 0.2255],
    [2172812345, 'CUP-00001', '410392999001', '영신내추럴', '콜드브루 100팩', '쿠팡', 2, 35000, 31500, 18000, 2800, 550, 0, 10150, 0.3222],
    [2172812346, 'NAV-00002', '410392999002', '영신내추럴', '에티오피아 2병', '스마트스토어', 1, 28000, 25200, 14000, 2800, 550, 0, 7850, 0.3115],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sample);
  ws['!cols'] = [10, 18, 16, 12, 28, 6, 14, 12, 12, 12, 8, 8, 8, 12, 8].map(w => ({ wch: w }));
  // 마진율 퍼센트 포맷
  for (let R = 1; R < sample.length; R++) {
    const cell = ws[XLSX.utils.encode_cell({ r: R, c: 14 })];
    if (cell) cell.z = '0.00%';
  }
  XLSX.utils.book_append_sheet(wb, ws, '판매기록');
  XLSX.writeFile(wb, '라이프컬처_판매기록_샘플.xlsx');
  showToast('샘플 엑셀 파일이 다운로드되었습니다.', 'success');
}

// ===========================
// 더보기 메뉴
// ===========================
function setupMoreMenu() {
  const btn = document.getElementById('moreMenuBtn');
  const overlay = document.getElementById('moreMenuOverlay');
  const sheet = document.getElementById('moreMenuSheet');
  const closeBtn = document.getElementById('moreMenuClose');
  const deleteAllBtn = document.getElementById('deleteAllBtn');

  const openMenu = () => {
    if (overlay) { overlay.style.display = 'block'; setTimeout(() => overlay.classList.add('show'), 10); }
    if (sheet) { sheet.style.display = 'block'; setTimeout(() => sheet.classList.add('show'), 10); }
  };
  const closeMenu = () => {
    if (overlay) { overlay.classList.remove('show'); setTimeout(() => { overlay.style.display = ''; }, 300); }
    if (sheet) { sheet.classList.remove('show'); setTimeout(() => { sheet.style.display = ''; }, 300); }
  };

  if (btn) btn.addEventListener('click', openMenu);
  if (closeBtn) closeBtn.addEventListener('click', closeMenu);
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closeMenu(); });
  if (deleteAllBtn) deleteAllBtn.addEventListener('click', () => { closeMenu(); deleteAllData(); });
  const deleteAllRawBtn = document.getElementById('deleteAllRawBtn');
  if (deleteAllRawBtn) deleteAllRawBtn.addEventListener('click', () => { closeMenu(); deleteAllRawData(); });
}

// ===========================
// 전체 삭제
// ===========================
function deleteAllData() {
  // 현재 필터링된 데이터 삭제
  const targets = filteredSales.length > 0 ? filteredSales : allSales;
  showConfirm(`필터링된 판매 데이터 ${targets.length}건을 삭제하시겠습니까?<br><small style="color:#e74c3c">삭제 후 복구할 수 없습니다.</small>`, async () => {
    const ids = targets.map(s => s.id);
    const progressWrap = document.getElementById('deleteProgressWrap');
    const progressBar = document.getElementById('deleteProgressBar');
    const progressLabel = document.getElementById('deleteProgressLabel');
    const progressPct = document.getElementById('deleteProgressPct');
    if (progressWrap) progressWrap.style.display = 'block';
    try {
      await apiBatchDelete('sales', ids, (done, total) => {
        const pct = Math.round((done / total) * 100);
        if (progressBar) progressBar.style.width = pct + '%';
        if (progressPct) progressPct.textContent = pct + '%';
        if (progressLabel) progressLabel.textContent = `삭제 중... ${done.toLocaleString()} / ${total.toLocaleString()}건`;
      });
      showToast(`✅ ${ids.length}건 삭제 완료`, 'success');
      if (progressWrap) progressWrap.style.display = 'none';
      await loadSales();
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
      if (progressWrap) progressWrap.style.display = 'none';
    }
  });
}

function deleteAllRawData() {
  // 모든 데이터 삭제
  showConfirm(`모든 판매 데이터 ${allSales.length}건을 완전 삭제하시겠습니까?<br><small style="color:#e74c3c">필터와 무관하게 <strong>모든 데이터</strong>가 삭제됩니다. 복구 불가.</small>`, async () => {
    const ids = allSales.map(s => s.id);
    const progressWrap = document.getElementById('deleteProgressWrap');
    const progressBar = document.getElementById('deleteProgressBar');
    const progressLabel = document.getElementById('deleteProgressLabel');
    const progressPct = document.getElementById('deleteProgressPct');
    if (progressWrap) progressWrap.style.display = 'block';
    try {
      await apiBatchDelete('sales', ids, (done, total) => {
        const pct = Math.round((done / total) * 100);
        if (progressBar) progressBar.style.width = pct + '%';
        if (progressPct) progressPct.textContent = pct + '%';
        if (progressLabel) progressLabel.textContent = `삭제 중... ${done.toLocaleString()} / ${total.toLocaleString()}건`;
      });
      showToast(`✅ 전체 ${ids.length}건 삭제 완료`, 'success');
      if (progressWrap) progressWrap.style.display = 'none';
      await loadSales();
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error');
      if (progressWrap) progressWrap.style.display = 'none';
    }
  });
}

// ===========================
// 엑셀 가져오기 (Import)
// ===========================
let importParsedData = [];  // 파싱된 행 데이터

// 컬럼명 → 내부 필드 매핑
const IMPORT_COL_MAP = {
  'DB번호': 'db_no',
  'DB No': 'db_no',
  '주문번호': 'order_no',
  '주문 번호': 'order_no',
  '송장번호': 'invoice_no',
  '송장 번호': 'invoice_no',
  '업체명': 'company',
  '업체': 'company',
  '제품명': 'product_name',
  '제품': 'product_name',
  '상품명': 'product_name',
  '옵션': 'product_name',  // 20260612 주문서 형식 대응
  '수량': 'qty',
  '쇼핑몰': 'channel',
  '채널': 'channel',
  '결제금액': 'payment',
  '결제 금액': 'payment',
  '정산금액': 'settlement',
  '정산 금액': 'settlement',
  '공급가': 'supply_price',
  '공급 가': 'supply_price',
  '택배비': 'delivery_fee',
  '택배 비': 'delivery_fee',
  '작업비': 'work_fee',
  '작업 비': 'work_fee',
  '포장박스': 'box_fee',
  '포장 박스': 'box_fee',
  '마진': 'margin',
  '마진율': 'margin_rate',
  '마진 율': 'margin_rate',
  // 피벗 테이블 형식 헤더명 (합계 : 필드명)
  '합계 : 수량': 'qty',
  '합계 : 결제금액': 'payment',
  '합계 : 정산금액': 'settlement',
  '합계 : 공급가': 'supply_price',
  '합계 : 택배비': 'delivery_fee',
  '합계 : 작업비': 'work_fee',
  '합계 : 포장박스': 'box_fee',
  '합계 : 마진': 'margin',
  '합계 : 마진율': 'margin_rate',
  '비고': 'remarks',
};

function setupImportModal() {
  const importBtn = document.getElementById('importExcelBtn');
  const modal = document.getElementById('importModal');
  const closeBtn = document.getElementById('importModalClose');
  const cancelBtn = document.getElementById('importCancelBtn');
  const confirmBtn = document.getElementById('importConfirmBtn');
  const dropZone = document.getElementById('importDropZone');
  const fileInput = document.getElementById('importFileInput');

  if (!modal) return;
  // 버튼 클릭 이벤트는 openImportModal() 함수로 연결됨 (중복 등록 방지)

  // 닫기
  const closeImport = () => { modal.classList.remove('show'); importParsedData = []; };
  if (closeBtn) closeBtn.addEventListener('click', closeImport);
  if (cancelBtn) cancelBtn.addEventListener('click', closeImport);
  modal.addEventListener('click', e => { if (e.target === modal) closeImport(); });

  // 드롭존 클릭 → 파일 선택
  if (dropZone) {
    dropZone.addEventListener('click', () => fileInput && fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = '#2C5F2E'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = '#ccc'; });
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.style.borderColor = '#ccc';
      const file = e.dataTransfer?.files?.[0];
      if (file) parseImportFile(file);
    });
  }

  // 파일 선택
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) parseImportFile(file);
    });
  }

  // 가져오기 확인 버튼
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (!importParsedData.length) return;

      // 판매일자 적용 (입력된 경우 모든 레코드에 덮어쓰기)
      const saleDateInput = document.getElementById('importSaleDate');
      const saleDate = saleDateInput?.value || '';
      const dataToSave = importParsedData.map(r => ({
        ...r,
        sale_date: saleDate || r.sale_date || new Date().toISOString().slice(0, 10),
      }));

      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...';

      // 진행률 바 표시
      const progressWrap = document.getElementById('importProgressWrap');
      const progressBar = document.getElementById('importProgressBar');
      const progressLabel = document.getElementById('importProgressLabel');
      const progressPct = document.getElementById('importProgressPct');
      if (progressWrap) progressWrap.style.display = 'block';

      try {
        await apiBatchPost('sales', dataToSave, (done, total) => {
          const pct = Math.round((done / total) * 100);
          if (progressBar) progressBar.style.width = pct + '%';
          if (progressPct) progressPct.textContent = pct + '%';
          if (progressLabel) progressLabel.textContent = `저장 중... ${done.toLocaleString()} / ${total.toLocaleString()}건`;
        });
        showToast(`✅ ${dataToSave.length}건 가져오기 완료!`, 'success');
        closeImport();
        await loadSales();
      } catch (err) {
        showToast('가져오기 실패: ' + err.message, 'error');
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="fas fa-upload"></i> <span id="importConfirmText">가져오기 실행</span>';
        if (progressWrap) progressWrap.style.display = 'none';
      }
    });
  }
}

function parseImportFile(file) {
  if (!file) return;
  if (typeof XLSX === 'undefined') { showToast('엑셀 라이브러리 로딩 중입니다. 잠시 후 다시 시도해주세요.', 'warning'); return; }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      if (rows.length < 2) {
        showToast('데이터가 없습니다. 헤더 행과 데이터 행이 필요합니다.', 'warning');
        return;
      }

      // 헤더 행 찾기 (첫 번째 행 또는 '업체명'이 있는 행)
      let headerRowIdx = 0;
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        const rowStr = rows[i].join(' ');
        if (rowStr.includes('업체명') || rowStr.includes('제품명') || rowStr.includes('쇼핑몰')) {
          headerRowIdx = i;
          break;
        }
      }

      const headers = rows[headerRowIdx].map(h => String(h).trim());
      const dataRows = rows.slice(headerRowIdx + 1).filter(r => r.some(c => c !== '' && c !== null && c !== undefined));

      // 헤더 → 필드 매핑
      const colMap = {};
      headers.forEach((h, idx) => {
        const field = IMPORT_COL_MAP[h];
        if (field) colMap[idx] = field;
      });

      if (!Object.values(colMap).includes('company') && !Object.values(colMap).includes('product_name')) {
        showToast('인식할 수 없는 파일 형식입니다. 샘플 엑셀을 참고하세요.', 'error');
        return;
      }

      // 데이터 변환
      importParsedData = dataRows.map(row => {
        const record = {
          sale_date: new Date().toISOString().slice(0, 10),
          db_no: 0, order_no: '', invoice_no: '', company: '',
          product_name: '', qty: 0, channel: '', payment: 0,
          settlement: 0, supply_price: 0, delivery_fee: 0,
          work_fee: 0, box_fee: 0, margin: 0, margin_rate: 0, remarks: '',
        };
        Object.entries(colMap).forEach(([colIdx, field]) => {
          let val = row[colIdx];
          if (val === '' || val === null || val === undefined) return;
          if (field === 'db_no' || field === 'qty') {
            // 쉼표, 공백, 비숫자 제거 후 파싱
            val = parseInt(String(val).replace(/[,\s]/g, '').replace(/[^0-9-]/g, '')) || 0;
          } else if (['payment', 'settlement', 'supply_price', 'delivery_fee', 'work_fee', 'box_fee', 'margin'].includes(field)) {
            // 쉼표, 원화기호(₩/원), 공백 제거 후 파싱 (피벗 테이블 "14,928" 형식 대응)
            val = parseFloat(String(val).replace(/[,\s₩원]/g, '').replace(/[^0-9.-]/g, '')) || 0;
          } else if (field === 'margin_rate') {
            // 마진율: 0.3117 또는 31.17% 형태 모두 처리
            val = parseFloat(String(val).replace(/[,%\s]/g, '').replace(/[^0-9.-]/g, ''));
            if (isNaN(val)) val = 0;
            if (val > 1) val = val / 100; // 31.17 → 0.3117
          } else {
            val = String(val).trim();
          }
          record[field] = val;
        });

        // 마진 자동계산 (마진 컬럼이 없는 경우)
        if (!Object.values(colMap).includes('margin')) {
          record.margin = record.settlement - record.supply_price - record.delivery_fee - record.work_fee - record.box_fee;
        }
        if (!Object.values(colMap).includes('margin_rate') && record.settlement > 0) {
          record.margin_rate = record.margin / record.settlement;
        }

        return record;
      }).filter(r => {
        if (!r.company && !r.product_name) return false; // 빈 행 제거
        // 합계/소계 행 제외: 업체명이 '합계', '소계', '전체', '열합계', '열소계', '열합', '열소', '행합계', '행소계', '합계열', '소계열', '열합', '열소', '열합계', '열소계', 'total' 등인 경우
        const companyLower = String(r.company || '').trim().toLowerCase();
        const SKIP = ['합계', '소계', '전체', '열합계', '열소계', '열합', '열소', '행합계', '행소계', '합계열', '소계열', 'total'];
        if (SKIP.some(k => companyLower.includes(k))) return false;
        return true;
      }); // 빈 행 및 합계 행 제거

      // 미리보기 렌더링
      renderImportPreview(headers, dataRows.slice(0, 5), importParsedData.length, file.name);

    } catch (err) {
      showToast('파일 파싱 오류: ' + err.message, 'error');
      console.error('[import]', err);
    }
  };
  reader.readAsArrayBuffer(file);
}

function renderImportPreview(headers, sampleRows, totalCount, fileName) {
  const preview = document.getElementById('importPreview');
  const titleEl = document.getElementById('importPreviewTitle');
  const countEl = document.getElementById('importPreviewCount');
  const thead = document.getElementById('importPreviewHead');
  const tbody = document.getElementById('importPreviewBody');
  const confirmBtn = document.getElementById('importConfirmBtn');
  const confirmText = document.getElementById('importConfirmText');
  const warning = document.getElementById('importWarning');
  const dropZone = document.getElementById('importDropZone');

  if (!preview) return;

  if (titleEl) titleEl.textContent = `📄 ${fileName}`;
  if (countEl) countEl.textContent = `총 ${totalCount}건 인식됨`;

  // 헤더 렌더링
  if (thead) {
    thead.innerHTML = `<tr>${headers.map(h => `<th style="padding:6px 10px;white-space:nowrap;font-weight:600">${h}</th>`).join('')}</tr>`;
  }

  // 데이터 미리보기 (최대 5행)
  if (tbody) {
    tbody.innerHTML = sampleRows.map(row =>
      `<tr>${headers.map((_, i) => `<td style="padding:5px 10px;border-bottom:1px solid #f0f0f0;white-space:nowrap">${row[i] !== undefined ? row[i] : ''}</td>`).join('')}</tr>`
    ).join('');
    if (totalCount > 5) {
      tbody.innerHTML += `<tr><td colspan="${headers.length}" style="padding:8px;text-align:center;color:#aaa;font-size:11px">... 외 ${totalCount - 5}건</td></tr>`;
    }
  }

  // 경고 메시지
  if (warning) {
    if (totalCount > 500) {
      warning.style.display = 'block';
      warning.innerHTML = `<i class="fas fa-exclamation-triangle"></i> ${totalCount}건의 데이터를 가져옵니다. 데이터가 많아 시간이 걸릴 수 있습니다.`;
    } else {
      warning.style.display = 'none';
    }
  }

  preview.style.display = 'block';
  if (dropZone) dropZone.style.borderColor = '#2C5F2E';

  if (confirmBtn) {
    confirmBtn.disabled = totalCount === 0;
    confirmBtn.innerHTML = `<i class="fas fa-upload"></i> <span id="importConfirmText">${totalCount}건 가져오기</span>`;
  }
}

// 가져오기 모달 열기 함수
function openImportModal() {
  const modal = document.getElementById('importModal');
  const fileInput = document.getElementById('importFileInput');
  const confirmBtn = document.getElementById('importConfirmBtn');
  const dropZone = document.getElementById('importDropZone');
  const preview = document.getElementById('importPreview');
  importParsedData = [];
  if (fileInput) fileInput.value = '';
  if (preview) preview.style.display = 'none';
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.innerHTML = '<i class="fas fa-upload"></i> <span id="importConfirmText">파일을 선택하세요</span>'; }
  if (dropZone) dropZone.style.borderColor = '#ccc';
  if (modal) modal.classList.add('show');
}

// DOMContentLoaded에 import 모달 초기화 추가
document.addEventListener('DOMContentLoaded', () => {
  setupImportModal();
});
