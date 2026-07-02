/* Name That Photo — voice-named photo capture for inspections
   All data stays on-device in IndexedDB. No server, no account. */

(() => {
  'use strict';

  /* ---------------- IndexedDB storage ---------------- */
  const DB_NAME = 'photo-namer-db';
  const DB_VERSION = 2; // v2 adds the "folders" store for per-property organization
  const STORE = 'photos';
  const FOLDERS_STORE = 'folders';
  let db;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains(FOLDERS_STORE)) {
          d.createObjectStore(FOLDERS_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Mobile Safari has a known IndexedDB bug: storing more than one Blob field
  // (e.g. `blob` + `originalBlob`) on the same record can silently corrupt one
  // of them on read-back — it loads later as a broken image. Workaround: never
  // store raw Blob objects, store ArrayBuffer + mime type instead, and rebuild
  // a real Blob whenever a record is read back out.
  function packBlob(blob) {
    return blob.arrayBuffer().then((buf) => ({ __buf: true, buf, type: blob.type }));
  }
  function unpackBlob(stored) {
    return stored && stored.__buf ? new Blob([stored.buf], { type: stored.type }) : stored;
  }
  async function packRecord(record) {
    const out = Object.assign({}, record);
    if (out.blob instanceof Blob) out.blob = await packBlob(out.blob);
    if (out.originalBlob instanceof Blob) out.originalBlob = await packBlob(out.originalBlob);
    return out;
  }
  function unpackRecord(record) {
    if (record.blob) record.blob = unpackBlob(record.blob);
    if (record.originalBlob) record.originalBlob = unpackBlob(record.originalBlob);
    return record;
  }

  async function dbAdd(record) {
    const packed = await packRecord(record);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(packed);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function dbDelete(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Writes several records in a single transaction — used to persist a manual
  // drag-and-drop reorder without one round trip per photo.
  async function dbPutAll(records) {
    const packed = await Promise.all(records.map(packRecord));
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      packed.forEach((r) => store.put(r));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function dbGetAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        // Sort by the manual drag-and-drop `order` field; photos saved before that
        // feature existed have no `order`, so they fall back to creation time.
        const records = req.result.map(unpackRecord);
        resolve(records.sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt)));
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Returns just the photos belonging to one property/folder — every gallery
  // action (grid, export, PDF report) is scoped to the active folder this way.
  async function getFolderPhotos(folderId) {
    const all = await dbGetAll();
    return all.filter((r) => r.folderId === folderId);
  }

  /* ---------------- Folders (properties) storage ---------------- */
  function dbAddFolder(folder) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FOLDERS_STORE, 'readwrite');
      tx.objectStore(FOLDERS_STORE).put(folder);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function dbDeleteFolder(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FOLDERS_STORE, 'readwrite');
      tx.objectStore(FOLDERS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function dbGetAllFolders() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FOLDERS_STORE, 'readonly');
      const req = tx.objectStore(FOLDERS_STORE).getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.createdAt - b.createdAt));
      req.onerror = () => reject(req.error);
    });
  }

  /* ---------------- Toast ---------------- */
  let toastTimer;
  function toast(msg, type) {
    const t = document.getElementById('toast-text');
    const wrap = document.getElementById('toast');
    t.textContent = msg;
    t.classList.toggle('success', type === 'success');
    wrap.classList.toggle('success', type === 'success');
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 1800);
  }

  /* ---------------- Elements ---------------- */
  const els = {
    cameraView: document.getElementById('camera-view'),
    galleryView: document.getElementById('gallery-view'),
    video: document.getElementById('preview'),
    previewCanvas: document.getElementById('preview-canvas'),
    shutter: document.getElementById('shutter'),
    flipCam: document.getElementById('flip-cam'),
    pickPhoto: document.getElementById('pick-photo'),
    compassToggle: document.getElementById('compass-toggle'),
    buildingToggle: document.getElementById('building-toggle'),
    silentToggle: document.getElementById('silent-toggle'),
    galleryBuildingBtn: document.getElementById('gallery-building-btn'),
    desktopImportMenuBtn: document.getElementById('desktop-import-menu-btn'),
    photoCount: document.getElementById('photo-count'),
    buildingReadout: document.getElementById('building-readout'),
    liveToggle: document.getElementById('live-toggle'),
    liveBadge: document.getElementById('live-badge'),
    liveRecordBtn: document.getElementById('live-record-btn'),
    liveSetupBtn: document.getElementById('live-setup-btn'),
    liveSetupModal: document.getElementById('live-setup-modal'),
    liveRoomInput: document.getElementById('live-room-input'),
    liveSetupCancel: document.getElementById('live-setup-cancel'),
    liveSetupSave: document.getElementById('live-setup-save'),
    liveSetupGenerate: document.getElementById('live-setup-generate'),
    watchLiveBtn: document.getElementById('watch-live-btn'),
    watchLiveBadge: document.getElementById('watch-live-badge'),
    watchLiveModal: document.getElementById('watch-live-modal'),
    watchLiveInput: document.getElementById('watch-live-input'),
    watchLiveCancel: document.getElementById('watch-live-cancel'),
    watchLiveJoin: document.getElementById('watch-live-join'),
    watchLiveFrameWrap: document.getElementById('watch-live-frame-wrap'),
    watchLiveVideo: document.getElementById('watch-live-video'),
    watchLiveAudio: document.getElementById('watch-live-audio'),
    watchLivePointerZone: document.getElementById('watch-live-pointer-zone'),
    watchLiveMute: document.getElementById('watch-live-mute'),
    watchLiveCapture: document.getElementById('watch-live-capture'),
    watchLiveLeave: document.getElementById('watch-live-leave'),
    watchLiveClose: document.getElementById('watch-live-close'),
    livePointerDot: document.getElementById('live-pointer-dot'),
    dskPlaceholder: document.getElementById('desktop-cam-placeholder'),
    dskSummaryCard: document.getElementById('dsk-summary-card'),
    dskSummaryName: document.getElementById('dsk-summary-name'),
    dskSummaryCount: document.getElementById('dsk-summary-count'),
    dskCatBreakdown: document.getElementById('dsk-cat-breakdown'),
    dskDropzone: document.getElementById('dsk-dropzone'),
    dskActionPdf: document.getElementById('dsk-action-pdf'),
    dskActionAttach: document.getElementById('dsk-action-attach'),
    dskActionSwitch: document.getElementById('dsk-action-switch'),
    dskActionDrive: document.getElementById('dsk-action-drive'),
    dskActionDrivePull: document.getElementById('dsk-action-drive-pull'),
    dskActionDriveLink: document.getElementById('dsk-action-drive-link'),
    dskRecentStrip: document.getElementById('dsk-recent-strip'),
    compassReadout: document.getElementById('compass-readout'),
    photoPicker: document.getElementById('photo-picker'),
    camStatus: document.getElementById('cam-status'),
    namingOverlay: document.getElementById('naming-overlay'),
    namingImg: document.getElementById('naming-photo-img'),
    importProgress: document.getElementById('import-progress'),
    transcriptText: document.getElementById('transcript-text'),
    micLabel: document.getElementById('mic-label'),
    micDot: document.getElementById('mic-dot'),
    btnRetry: document.getElementById('btn-retry'),
    btnEdit: document.getElementById('btn-edit'),
    btnSave: document.getElementById('btn-save'),
    namingCatRow: document.getElementById('naming-cat-row'),
    namingSublocDir: document.getElementById('naming-subloc-dir'),
    namingRoomRow: document.getElementById('naming-room-row'),
    namingRoomSelect: document.getElementById('naming-room-select'),
    tabCamera: document.getElementById('tab-camera'),
    tabGallery: document.getElementById('tab-gallery'),
    grid: document.getElementById('grid'),
    emptyState: document.getElementById('empty-state'),
    buildingFilterBar: document.getElementById('building-filter-bar'),
    gallerySearch: document.getElementById('gallery-search'),
    gallerySearchMic: document.getElementById('gallery-search-mic'),
    exportBtn: document.getElementById('export-btn'),
    exportQualityMenu: document.getElementById('export-quality-menu'),
    exportQualityStandardBtn: document.getElementById('export-quality-standard'),
    exportQualityFullBtn: document.getElementById('export-quality-full'),
    pdfAllBtn: document.getElementById('pdf-all-btn'),
    attachDocBtn: document.getElementById('attach-doc-btn'),
    docPicker: document.getElementById('doc-picker'),
    backupBtn: document.getElementById('backup-btn'),
    driveSyncBtn: document.getElementById('drive-sync-btn'),
    drivePullBtn: document.getElementById('drive-pull-btn'),
    driveLinkBtn: document.getElementById('drive-link-btn'),
    driveStatusText: document.getElementById('drive-status-text'),
    driveConnectBtn: document.getElementById('drive-connect-btn'),
    driveDisconnectBtn: document.getElementById('drive-disconnect-btn'),
    drivePullModal: document.getElementById('drive-pull-modal'),
    drivePullStatus: document.getElementById('drive-pull-status'),
    drivePullList: document.getElementById('drive-pull-list'),
    drivePullClose: document.getElementById('drive-pull-close'),
    selectBtn: document.getElementById('select-btn'),
    reorderBtn: document.getElementById('reorder-btn'),
    bulkBar: document.getElementById('bulk-bar'),
    bulkCount: document.getElementById('bulk-count'),
    selectAllBtn: document.getElementById('select-all-btn'),
    bulkRename: document.getElementById('bulk-rename'),
    bulkMarkup: document.getElementById('bulk-markup'),
    bulkCrop: document.getElementById('bulk-crop'),
    bulkRemoveMarkup: document.getElementById('bulk-remove-markup'),
    bulkCategorize: document.getElementById('bulk-categorize'),
    bulkMoveBuilding: document.getElementById('bulk-move-building'),
    bulkMoveProject: document.getElementById('bulk-move-project'),
    bulkPdf: document.getElementById('bulk-pdf'),
    bulkDownload: document.getElementById('bulk-download'),
    bulkShare: document.getElementById('bulk-share'),
    bulkDelete: document.getElementById('bulk-delete'),
    renameModal: document.getElementById('rename-modal'),
    renameInput: document.getElementById('rename-input'),
    renameMic: document.getElementById('rename-mic'),
    renameCancel: document.getElementById('rename-cancel'),
    renameSave: document.getElementById('rename-save'),
    recatModal: document.getElementById('recat-modal'),
    recatCatRow: document.getElementById('recat-cat-row'),
    recatSublocDir: document.getElementById('recat-subloc-dir'),
    recatRoomRow: document.getElementById('recat-room-row'),
    recatRoomSelect: document.getElementById('recat-room-select'),
    recatCancel: document.getElementById('recat-cancel'),
    recatSave: document.getElementById('recat-save'),
    moveBuildingModal: document.getElementById('move-building-modal'),
    moveBuildingTitle: document.getElementById('move-building-title'),
    moveBuildingList: document.getElementById('move-building-list'),
    moveBuildingCancel: document.getElementById('move-building-cancel'),
    moveBuildingNewInput: document.getElementById('move-building-new-input'),
    moveBuildingNewMic: document.getElementById('move-building-new-mic'),
    moveBuildingNewAdd: document.getElementById('move-building-new-add'),
    moveProjectModal: document.getElementById('move-project-modal'),
    moveProjectTitle: document.getElementById('move-project-title'),
    moveProjectList: document.getElementById('move-project-list'),
    moveProjectCancel: document.getElementById('move-project-cancel'),
    projectBanner: document.getElementById('project-banner'),
    projectBannerLabel: document.getElementById('project-banner-label'),
    projectBannerName: document.getElementById('project-banner-name'),
    foldersModal: document.getElementById('folders-modal'),
    foldersSearch: document.getElementById('folders-search'),
    foldersSearchMic: document.getElementById('folders-search-mic'),
    foldersList: document.getElementById('folders-list'),
    newFolderInput: document.getElementById('new-folder-input'),
    newFolderMic: document.getElementById('new-folder-mic'),
    foldersClose: document.getElementById('folders-close'),
    newFolderAdd: document.getElementById('new-folder-add'),
    buildingsModal: document.getElementById('buildings-modal'),
    buildingsList: document.getElementById('buildings-list'),
    newBuildingInput: document.getElementById('new-building-input'),
    newBuildingMic: document.getElementById('new-building-mic'),
    buildingsClose: document.getElementById('buildings-close'),
    newBuildingAdd: document.getElementById('new-building-add'),
    projectGate: document.getElementById('project-gate'),
    projectGateCreate: document.getElementById('project-gate-create'),
    projectGateSelect: document.getElementById('project-gate-select'),
    cameraStartPrompt: document.getElementById('camera-start-prompt'),
    cameraStartName: document.getElementById('camera-start-project-name'),
    cameraStartGo: document.getElementById('camera-start-go'),
    cameraStartPdf: document.getElementById('camera-start-pdf'),
    dskPromptModal: document.getElementById('dsk-project-prompt-modal'),
    dskPromptName: document.getElementById('dsk-project-prompt-name'),
    dskPromptSkip: document.getElementById('dsk-project-prompt-skip'),
    dskPromptPdf: document.getElementById('dsk-project-prompt-pdf'),
    appRoot: document.getElementById('app'),
    authView: document.getElementById('auth-view'),
    authTitle: document.getElementById('auth-title'),
    authSubtitle: document.getElementById('auth-subtitle'),
    authError: document.getElementById('auth-error'),
    authEmail: document.getElementById('auth-email'),
    authPassword: document.getElementById('auth-password'),
    authSubmit: document.getElementById('auth-submit'),
    authToggleMode: document.getElementById('auth-toggle-mode'),
    authForgot: document.getElementById('auth-forgot'),
    paywallView: document.getElementById('paywall-view'),
    paywallError: document.getElementById('paywall-error'),
    paywallStart: document.getElementById('paywall-start'),
    paywallRefresh: document.getElementById('paywall-refresh'),
    paywallSignout: document.getElementById('paywall-signout'),
    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: document.getElementById('settings-modal'),
    settingsClose: document.getElementById('settings-close'),
    stgCompanyInput: document.getElementById('stg-company-input'),
    stgCompanyAddressInput: document.getElementById('stg-company-address-input'),
    stgCompanyCityInput: document.getElementById('stg-company-city-input'),
    stgCompanyStateInput: document.getElementById('stg-company-state-input'),
    stgCompanyZipInput: document.getElementById('stg-company-zip-input'),
    stgContactInput: document.getElementById('stg-contact-input'),
    stgInspectorInput: document.getElementById('stg-inspector-input'),
    stgLicenseInput: document.getElementById('stg-license-input'),
    stgInspectorPhoneInput: document.getElementById('stg-inspector-phone-input'),
    stgInspectorEmailInput: document.getElementById('stg-inspector-email-input'),
    stgLogoPick: document.getElementById('stg-logo-pick'),
    stgLogoClear: document.getElementById('stg-logo-clear'),
    stgLogoFile: document.getElementById('stg-logo-file'),
    stgLogoPreview: document.getElementById('stg-logo-preview'),
    stgLogoPreviewImg: document.getElementById('stg-logo-preview-img'),
    stgSaveProfileBtn: document.getElementById('stg-save-profile-btn'),
    stgDriveStatusRow: document.getElementById('stg-drive-status-row'),
    stgDriveStatusText: document.getElementById('stg-drive-status-text'),
    stgDriveConnectBtn: document.getElementById('stg-drive-connect-btn'),
    stgDriveDisconnectBtn: document.getElementById('stg-drive-disconnect-btn'),
    setupWizard: document.getElementById('setup-wizard'),
    setupStepNum: document.getElementById('setup-step-num'),
    setupStep1: document.getElementById('setup-step-1'),
    setupStep2: document.getElementById('setup-step-2'),
    setupCompanyInput: document.getElementById('setup-company-input'),
    setupCompanyAddressInput: document.getElementById('setup-company-address-input'),
    setupCompanyCityInput: document.getElementById('setup-company-city-input'),
    setupCompanyStateInput: document.getElementById('setup-company-state-input'),
    setupCompanyZipInput: document.getElementById('setup-company-zip-input'),
    setupContactInput: document.getElementById('setup-contact-input'),
    setupLogoPick: document.getElementById('setup-logo-pick'),
    setupLogoClear: document.getElementById('setup-logo-clear'),
    setupLogoFile: document.getElementById('setup-logo-file'),
    setupLogoPreview: document.getElementById('setup-logo-preview'),
    setupLogoPreviewImg: document.getElementById('setup-logo-preview-img'),
    setupInspectorInput: document.getElementById('setup-inspector-input'),
    setupLicenseInput: document.getElementById('setup-license-input'),
    setupInspectorPhoneInput: document.getElementById('setup-inspector-phone-input'),
    setupInspectorEmailInput: document.getElementById('setup-inspector-email-input'),
    setupNextBtn: document.getElementById('setup-next-btn'),
    setupDriveStatusRow: document.getElementById('setup-drive-status-row'),
    setupDriveStatusText: document.getElementById('setup-drive-status-text'),
    setupDriveConnectBtn: document.getElementById('setup-drive-connect-btn'),
    setupDriveDisconnectBtn: document.getElementById('setup-drive-disconnect-btn'),
    setupFinishBtn: document.getElementById('setup-finish-btn'),
    setupSkipDrive: document.getElementById('setup-skip-drive'),
    accountBtn: document.getElementById('account-btn'),
    accountView: document.getElementById('account-view'),
    accountStatusText: document.getElementById('account-status-text'),
    accountError: document.getElementById('account-error'),
    accountManage: document.getElementById('account-manage'),
    accountSignoutBtn: document.getElementById('account-signout-btn'),
    accountClose: document.getElementById('account-close'),
    adminView: document.getElementById('admin-view'),
    adminStatus: document.getElementById('admin-status'),
    adminEmail: document.getElementById('admin-email'),
    adminBetaToggle: document.getElementById('admin-beta-toggle'),
    adminSave: document.getElementById('admin-save'),
    adminClose: document.getElementById('admin-close'),
  };

  /* ---------------- State ---------------- */
  let stream = null;
  let facingMode = 'environment';
  let lastFrameSignature = null; // detects a frozen camera feed (see capturePhoto)
  const SILENT_MODE_KEY = 'pn_silent_mode';
  const AUTO_SYNC_KEY = 'pn_auto_sync';
  const AUTO_SYNC_INTERVAL_KEY = 'pn_auto_sync_interval';
  let silentMode = localStorage.getItem(SILENT_MODE_KEY) === '1';
  let silentPhotoCount = 0;
  let autoSyncEnabled = localStorage.getItem(AUTO_SYNC_KEY) === '1';
  let autoSyncIntervalMin = parseInt(localStorage.getItem(AUTO_SYNC_INTERVAL_KEY) || '2', 10);
  if (![1, 2, 3].includes(autoSyncIntervalMin)) autoSyncIntervalMin = 2;
  let autoSyncTimer = null;
  let autoSyncRunning = false; // session counter for auto-named photos
  let pendingBlob = null;     // photo awaiting a name
  let pendingOriginalBlob = null; // pre-markup blob, set only if the pending photo was annotated before save
  let currentTranscript = '';
  let recognition = null;
  let recognizing = false;
  let recognitionTornDown = true; // false while a previous recognition session is still releasing the mic
  let renameTargetId = null;
  let silenceTimer = null;
  const SILENCE_AUTOSAVE_MS = 1600; // auto-confirm shortly after speech pauses
  let pendingImported = false;     // true if pendingBlob came from the photo library, not the camera
  let importQueue = [];
  let importTotal = 0;
  let pendingCategory = '';        // '' (Other), 'exterior', 'roof', or 'interior'
  let pendingSubLocation = '';     // exterior: elevation word (Front/Right/Rear/Left); interior: picked room name
  let pendingHeading = null;       // compass heading at the moment this photo was captured, if known
  let pendingFrontFacing = null;   // active property's "front faces" direction, fetched when the tag row is opened
  let selectMode = false;
  let selectedIds = new Set();
  let galleryIds = []; // ids currently rendered in the grid, for Select all
  let reorderMode = false;
  let reorderSelected = new Set(); // IDs tapped for group move in reorder mode
  let currentFolderId = null;     // the active property/folder — scopes capture + gallery
  let currentFolderName = '';
  let pdfTitleAutoFilled = true;  // tracks whether the PDF title still matches the folder-name default
  const CURRENT_FOLDER_KEY = 'photoNamerCurrentFolder';
  let folderSearchQuery = ''; // lowercase filter typed into the properties modal search box
  let gallerySearchQuery = ''; // lowercase filter typed into the gallery's photo-name search box
  let activeBuildingFilter = null; // null = show all; string = show only that building

  // Multi-building support (task #141) — buildings are scoped per project/folder, not
  // per-photo like category/subLocation: unlike those, a building must persist across
  // many shots until the inspector physically moves to a different structure and
  // explicitly switches, so it lives in localStorage keyed by folder rather than
  // resetting in closeNaming(). projectBuildings is the list created so far (free-text,
  // on the fly); currentBuilding ('' by default) is stamped onto every photo saved
  // while it's active. Reports/galleries for projects that never touch this feature are
  // byte-for-byte unaffected — see groupIntoSections()'s early-return for the no-building case.
  let projectBuildings = [];
  let currentBuilding = '';

  function buildingStorageKey(folderId) { return 'pn_buildings_' + folderId; }

  function loadBuildingState(folderId) {
    projectBuildings = [];
    currentBuilding = '';
    try {
      const raw = localStorage.getItem(buildingStorageKey(folderId));
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data.list)) projectBuildings = data.list;
        if (typeof data.current === 'string') currentBuilding = data.current;
      }
    } catch (err) { /* corrupt/missing — fall back to no buildings */ }
  }

  function saveBuildingState(folderId) {
    localStorage.setItem(buildingStorageKey(folderId), JSON.stringify({ list: projectBuildings, current: currentBuilding }));
  }

  function updateBuildingReadout() {
    if (!els.buildingReadout) return;
    els.buildingReadout.textContent = currentBuilding || '';
    els.buildingReadout.classList.toggle('hidden', !currentBuilding);
  }

  // Building filter/assign bar — rendered above the gallery search box whenever the
  // current project has at least one named building. Dual-purpose:
  //   • No selection active: tapping a pill filters the gallery to that building only.
  //     Tapping "All" clears the filter. Active pill turns blue.
  //   • Select mode active (photos checked): tapping a pill immediately assigns all
  //     selected photos to that building and exits select mode. Pills turn green-bordered
  //     ("assign-ready") to signal the different action.
  function renderBuildingFilterBar() {
    const bar = els.buildingFilterBar;
    bar.innerHTML = '';
    const hasBuildings = projectBuildings.length > 0;
    const assignMode = selectMode && selectedIds.size > 0;


    if (hasBuildings) {
      // "All" pill — filter only, not an assign target
      const allPill = document.createElement('button');
      allPill.className = 'bldg-pill' + (!activeBuildingFilter && !assignMode ? ' active' : '');
      allPill.dataset.building = '';
      allPill.textContent = 'All';
      allPill.addEventListener('click', () => {
        if (assignMode) return;
        activeBuildingFilter = null;
        renderBuildingFilterBar();
        refreshGallery();
      });
      bar.appendChild(allPill);

      projectBuildings.forEach((b) => {
        const pill = document.createElement('button');
        pill.className = 'bldg-pill' + (!assignMode && b === activeBuildingFilter ? ' active' : '');
        if (assignMode) pill.classList.add('assign-ready');
        pill.dataset.building = b;
        pill.textContent = b;
        pill.addEventListener('click', async () => {
          if (assignMode) {
            const records = await dbGetAll();
            const targetSet = new Set(selectedIds);
            const matches = records.filter((r) => targetSet.has(r.id));
            for (const rec of matches) { rec.building = b; await dbAdd(rec); }
            const count = matches.length;
            toast(`${count} photo${count === 1 ? '' : 's'} assigned to ${b}`);
            selectedIds.clear();
            selectMode = false;
            els.selectBtn.classList.remove('active');
            renderBuildingFilterBar();
            refreshGallery();
          } else {
            activeBuildingFilter = b;
            renderBuildingFilterBar();
            refreshGallery();
          }
        });
        bar.appendChild(pill);
      });
    }


  }

  // Buildings modal — replaced the original prompt()-based menu (task #141 follow-up)
  // so the "Add a Building" field can carry a mic button, same as every other
  // free-text field in this app (project name, photo name, PDF fields). Tapping an
  // existing building row switches to it with one tap; speaking or typing a new name
  // into the input and tapping Add & Switch creates one. Selecting by voice means
  // dictating the name into the input — there is no "say the number" voice path,
  // since the mic only ever targets the one text field, matching attachDictation's
  // existing one-field-per-button design used everywhere else in the app.
  function renderBuildingsList() {
    els.buildingsList.innerHTML = '';
    if (!projectBuildings.length) {
      const empty = document.createElement('div');
      empty.id = 'buildings-empty';
      empty.textContent = 'No buildings added yet for this project.';
      els.buildingsList.appendChild(empty);
      return;
    }
    projectBuildings.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'building-row' + (b === currentBuilding ? ' current' : '');
      const name = document.createElement('div');
      name.className = 'building-row-name';
      name.textContent = b;
      row.appendChild(name);
      if (b === currentBuilding) {
        const tag = document.createElement('div');
        tag.className = 'building-row-tag';
        tag.textContent = 'CURRENT';
        row.appendChild(tag);
      }
      row.addEventListener('click', () => {
        currentBuilding = b;
        saveBuildingState(currentFolderId);
        updateBuildingReadout();
        toast(`Building: ${currentBuilding}`);
        closeBuildingsModal();
      });
      els.buildingsList.appendChild(row);
    });
  }

  function openBuildingsModal() {
    els.newBuildingInput.value = '';
    renderBuildingsList();
    els.buildingsModal.classList.add('active');
  }

  function closeBuildingsModal() {
    els.buildingsModal.classList.remove('active');
    if (els.newBuildingInput) els.newBuildingInput.blur();
    // Restart the live feed on close (task #141 follow-up — reported as "camera stuck
    // on last photo" after switching buildings). Focusing the building-name field wakes
    // the iOS keyboard, which can mute the active camera track without ever firing
    // onunmute, leaving the preview frozen on whatever frame was showing when the modal
    // opened. A fresh stopCamera()+startCamera() cycle — the same recovery the Gallery
    // tab already performs on every visit (see showGallery/showCamera) — guarantees a
    // live feed again regardless of what iOS did to the old track while the modal was up.
    if (!isDesktopDevice() && hasRealProject() && !els.cameraView.classList.contains('hidden')) {
      startCamera();
    }
  }

  function addBuildingFromInput() {
    const typed = els.newBuildingInput.value.trim();
    if (!typed) { alert('Enter or speak a building name.'); return; }
    if (!projectBuildings.includes(typed)) projectBuildings.push(typed);
    currentBuilding = typed;
    saveBuildingState(currentFolderId);
    updateBuildingReadout();
    renderBuildingFilterBar();
    toast(`Building: ${currentBuilding}`);
    closeBuildingsModal();
  }

  /* ---------------- Folders (properties) ---------------- */
  // Ensures at least one folder exists, restores the last-active folder from
  // localStorage (falling back to the first folder), and buckets any legacy
  // photos saved before this feature existed into that folder so nothing is lost.
  async function bootstrapFolders() {
    let folders = await dbGetAllFolders();
    if (!folders.length) {
      // isDefault marks this as the auto-created holding folder, not a real
      // user-named project — it stays out of the Projects list/search until it
      // actually has photos in it, and never shows the current-project pill.
      const def = { id: 'f_' + Date.now(), name: 'My Inspection', createdAt: Date.now(), isDefault: true };
      await dbAddFolder(def);
      folders = [def];
    }

    const allPhotos = await dbGetAll();
    const orphans = allPhotos.filter((r) => !r.folderId);
    if (orphans.length) {
      const target = folders[0].id;
      orphans.forEach((r) => { r.folderId = target; });
      await dbPutAll(orphans);
    }

    const saved = localStorage.getItem(CURRENT_FOLDER_KEY);
    const active = folders.find((f) => f.id === saved) || folders[0];
    currentFolderId = active.id;
    currentFolderName = active.name;
    updateFolderChip();
    loadBuildingState(currentFolderId);
    updateBuildingReadout();
    renderBuildingFilterBar();
  }

  const HAS_CREATED_PROJECT_KEY = 'pn_has_created_project';

  /* ---------------- Google Drive sync (tasks #29-32) ----------------
     Lets an inspector push the current project's photos to their own Google Drive
     so a desk reviewer (or the inspector on another device) can pull them down —
     IndexedDB itself never leaves the device that captured the photos, so this is
     the bridge between phone and desktop. Manual, on-demand sync only (no
     background/auto sync): the user taps "Sync to Drive" and it uploads whatever
     in the current project hasn't been uploaded yet.

     Scope is drive.file — the app can only see/manage files and folders it
     creates itself, never the rest of the user's Drive. This keeps the OAuth
     consent screen out of Google's "sensitive scope" review requirements until
     the >100-user Production threshold is crossed (informational; not yet hit). */
  const GOOGLE_DRIVE_CLIENT_ID = '172555510278-ih8a1csf4482uggeeu536n62itfqchkn.apps.googleusercontent.com';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const DRIVE_ROOT_FOLDER_NAME = 'Name That Photo';
  const DRIVE_CONNECTED_KEY = 'pn_drive_connected';

  let driveTokenClient = null;
  let driveAccessToken = null;
  let driveTokenExpiresAt = 0; // epoch ms
  let driveRootFolderId = null; // cached for the session once found/created

  function initDriveAuth() {
    if (driveTokenClient || !window.google?.accounts?.oauth2) return;
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_DRIVE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: () => {}, // overridden per-call below
    });
  }

  // Resolves with a valid access token, prompting the user only if we don't already
  // have one (or it expired). `interactive:false` is used for the silent "are we
  // still connected" check on app load; it resolves to null instead of popping a
  // consent screen if the user needs to re-grant.
  function getDriveAccessToken({ interactive = true } = {}) {
    return new Promise((resolve) => {
      if (driveAccessToken && Date.now() < driveTokenExpiresAt - 30000) {
        resolve(driveAccessToken);
        return;
      }
      if (!window.google?.accounts?.oauth2) { resolve(null); return; }
      initDriveAuth();
      driveTokenClient.callback = (resp) => {
        if (resp.error) { resolve(null); return; }
        driveAccessToken = resp.access_token;
        driveTokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        localStorage.setItem(DRIVE_CONNECTED_KEY, '1');
        resolve(driveAccessToken);
      };
      // prompt:'' lets GIS reuse an existing grant silently when one exists; if none
      // exists and interactive is false, it just fails closed rather than popping UI.
      try {
        driveTokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function disconnectDrive() {
    if (driveAccessToken && window.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(driveAccessToken, () => {});
    }
    driveAccessToken = null;
    driveTokenExpiresAt = 0;
    driveRootFolderId = null;
    localStorage.removeItem(DRIVE_CONNECTED_KEY);
    updateDriveStatusUI();
  }

  function updateDriveStatusUI() {
    if (!els.driveStatusText) return;
    const connected = !!driveAccessToken || localStorage.getItem(DRIVE_CONNECTED_KEY) === '1';
    els.driveStatusText.textContent = connected ? 'Google Drive: Connected' : 'Google Drive: Not connected';
    if (els.driveConnectBtn) els.driveConnectBtn.classList.toggle('hidden', connected);
    if (els.driveDisconnectBtn) els.driveDisconnectBtn.classList.toggle('hidden', !connected);
  }

  // Finds a folder by exact name under `parentId` (or Drive root if omitted),
  // creating it if it doesn't exist. Used for both the top-level "Name That Photo"
  // folder and each project's subfolder.
  async function ensureDriveFolder(name, parentId, token) {
    const parentClause = parentId ? `'${parentId}' in parents` : `'root' in parents`;
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and ${parentClause} and trashed=false`
    );
    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length) return searchData.files[0].id;

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined,
      }),
    });
    const createData = await createRes.json();
    return createData.id;
  }

  async function uploadFileToDrive(folderId, filename, blob, mimeType, token) {
    const metadata = { name: filename, parents: [folderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob, filename);
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Drive upload failed (${res.status})`);
    return res.json();
  }

  // Uploads (or replaces) a _metadata.json sidecar in the project's Drive folder.
  // This sidecar lets any device that pulls the project restore category/subLocation/
  // building/heading/name for each photo — fields that aren't encoded in the filename.
  async function syncMetadataToDrive(projectFolderId, records, token) {
    const entries = records
      .filter((r) => r.driveFileId)
      .map((r) => ({
        driveFileId: r.driveFileId,
        name: r.name || '',
        category: r.category || '',
        subLocation: r.subLocation || '',
        building: r.building || '',
        heading: r.heading != null ? r.heading : null,
        order: r.order != null ? r.order : null,
      }));
    if (!entries.length) return;
    const blob = new Blob([JSON.stringify(entries)], { type: 'application/json' });
    // Check if sidecar already exists so we update rather than accumulate copies.
    const q = encodeURIComponent(`name='_metadata.json' and '${projectFolderId}' in parents and trashed=false`);
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listData = await listRes.json();
    const existing = listData.files && listData.files[0];
    const form = new FormData();
    if (existing) {
      form.append('metadata', new Blob([JSON.stringify({ name: '_metadata.json' })], { type: 'application/json' }));
      form.append('file', blob, '_metadata.json');
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
    } else {
      form.append('metadata', new Blob([JSON.stringify({ name: '_metadata.json', parents: [projectFolderId] })], { type: 'application/json' }));
      form.append('file', blob, '_metadata.json');
      await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
    }
  }

  // Manual sync: uploads every photo/PDF in the current project that hasn't been
  // synced yet into Drive/Name That Photo/<project name>. Each record is flagged
  // driveSynced (mirrors the backedUp flag pattern from Backup-to-Photos) so
  // re-running only sends what's new.
  // ── Auto-Sync (timer-based, silent) ──────────────────────────────────────────
  async function autoSyncToDrive() {
    if (autoSyncRunning) return;           // don't stack if previous run is still going
    if (!currentFolderId) return;          // no project selected
    const token = await getDriveAccessToken({ interactive: false });
    if (!token) {
      // Silent token failed — likely expired or never obtained this session.
      // Nudge the user so they know auto-sync is stalled rather than working.
      if (localStorage.getItem(DRIVE_CONNECTED_KEY) === '1') {
        toast('☁️ Auto-Sync paused — tap Menu → Send to Cloud to reconnect Drive');
      }
      return;
    }
    const records = await getFolderPhotos(currentFolderId);
    const pending = records.filter((r) => !r.driveSynced);
    if (!pending.length) return;           // nothing new to upload
    autoSyncRunning = true;
    try {
      if (!driveRootFolderId) driveRootFolderId = await ensureDriveFolder(DRIVE_ROOT_FOLDER_NAME, null, token);
      const projectFolderId = await ensureDriveFolder(currentFolderName || 'Untitled Project', driveRootFolderId, token);
      const usedNames = new Map();
      let synced = 0;
      for (const rec of pending) {
        const isVideo = rec.kind === 'video';
        const mimeType = rec.blob.type || (isVideo ? 'video/mp4' : 'image/jpeg');
        const ext = isVideo ? (mimeType.includes('mp4') ? 'mp4' : 'webm') : (rec.kind === 'pdf' ? 'pdf' : 'jpg');
        const base = sanitizeFilename(rec.name);
        const count = usedNames.get(base) || 0;
        usedNames.set(base, count + 1);
        const filename = count === 0 ? `${base}.${ext}` : `${base}_${count + 1}.${ext}`;
        try {
          const result = await uploadFileToDrive(projectFolderId, filename, rec.blob, mimeType, token);
          rec.driveSynced = true;
          rec.driveFileId = result.id;
          await dbPutAll([rec]);
          synced += 1;
        } catch (e) { break; } // network error — try again next interval
      }
      if (synced > 0) {
        try {
          const allRecords = await getFolderPhotos(currentFolderId);
          await syncMetadataToDrive(projectFolderId, allRecords, token);
        } catch (_) { /* non-critical — photos are already synced */ }
        toast(`☁️ Auto-synced ${synced} photo${synced === 1 ? '' : 's'} to Drive`);
        // Flip cloud badges in-place so the inspector's scroll position is preserved.
        // If the grid hasn't been rendered yet (user is on the camera view), fall back
        // to a full refreshGallery() so the badges are correct when they next open the gallery.
        const syncedRecs = pending.slice(0, synced);
        const gridHasThumbs = els.grid && els.grid.querySelector('.thumb');
        if (gridHasThumbs) {
          for (const rec of syncedRecs) {
            const badge = els.grid.querySelector(`[data-id="${rec.id}"] .cloud-badge`);
            if (badge) {
              badge.className = 'cloud-badge';
              badge.title = 'Saved to Cloud';
            }
          }
        } else {
          refreshGallery();
        }
      }
    } catch (e) { /* silent — try again next interval */ }
    finally { autoSyncRunning = false; }
  }

  function applyAutoSyncToggle() {
    const btn = document.getElementById('auto-sync-btn');
    if (!btn) return;
    btn.textContent = autoSyncEnabled
      ? `⏱️ Auto-Sync: On (${autoSyncIntervalMin} min)`
      : '⏱️ Auto-Sync: Off';
    btn.style.background = autoSyncEnabled ? '#30d158' : '';
    btn.style.borderColor = autoSyncEnabled ? '#30d158' : '';
    // Highlight whichever interval button matches the current setting
    document.querySelectorAll('.sync-interval-btn').forEach((b) => {
      b.classList.toggle('selected', parseInt(b.dataset.min, 10) === autoSyncIntervalMin);
    });
  }

  function startAutoSync({ skipImmediate = false } = {}) {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    if (!skipImmediate) autoSyncToDrive(); // run immediately on enable
    autoSyncTimer = setInterval(autoSyncToDrive, autoSyncIntervalMin * 60 * 1000);
  }

  function stopAutoSync() {
    if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  }

  async function syncFolderToDrive() {
    // Request the Drive token FIRST — before any other await. iOS Safari (and the installed
    // PWA's standalone mode is even stricter about this) revokes "user activation" the moment
    // the call stack yields back to the event loop, which is exactly what the old order did:
    // it awaited an IndexedDB read (getFolderPhotos) before ever calling
    // requestAccessToken(), so by the time GIS tried to open its OAuth popup, the tap was no
    // longer "fresh" and Safari silently blocked the popup — no error, it just did nothing.
    // Desktop Chrome is far more lenient about activation surviving a microtask/IDB round
    // trip, which is why the exact same code worked there. Calling getDriveAccessToken as the
    // first synchronous step keeps requestAccessToken() in the same tap gesture on every
    // platform.
    const token = await getDriveAccessToken({ interactive: true });
    if (!token) { toast('Google Drive sign-in was cancelled or failed'); return; }
    updateDriveStatusUI();

    const records = await getFolderPhotos(currentFolderId);
    if (!records.length) { toast('No photos in this project yet'); return; }
    let pending = records.filter((r) => !r.driveSynced);
    if (!pending.length) {
      // All records are flagged synced locally — verify Drive still has the files.
      // If the user deleted the project folder from Drive, we need to reset and re-upload.
      if (!driveRootFolderId) driveRootFolderId = await ensureDriveFolder(DRIVE_ROOT_FOLDER_NAME, null, token);
      const checkFolderId = await ensureDriveFolder(currentFolderName || 'Untitled Project', driveRootFolderId, token);
      const driveFiles = await listDriveFilesInFolder(checkFolderId, token);
      const driveFileIdSet = new Set(driveFiles.filter((f) => f.name !== '_metadata.json').map((f) => f.id));
      const orphaned = records.filter((r) => r.driveFileId && !driveFileIdSet.has(r.driveFileId));
      if (!orphaned.length) {
        alert(`All ${records.length} item${records.length === 1 ? '' : 's'} in this project are already synced to Drive.`);
        return;
      }
      // Reset orphaned records so the upload loop below re-sends them
      for (const rec of orphaned) { rec.driveSynced = false; rec.driveFileId = null; }
      await dbPutAll(orphaned);
      toast(`Drive folder was deleted — re-syncing ${orphaned.length} item${orphaned.length === 1 ? '' : 's'}…`);
      pending = orphaned;
    }

    els.driveSyncBtn.disabled = true;
    const origText = els.driveSyncBtn.textContent;
    try {
      if (!driveRootFolderId) driveRootFolderId = await ensureDriveFolder(DRIVE_ROOT_FOLDER_NAME, null, token);
      const projectFolderId = await ensureDriveFolder(currentFolderName || 'Untitled Project', driveRootFolderId, token);

      const usedNames = new Map();
      let synced = 0;
      for (const rec of pending) {
        els.driveSyncBtn.textContent = `Syncing ${synced + 1}/${pending.length}…`;
        const isVideo = rec.kind === 'video';
        const mimeType = rec.blob.type || (isVideo ? 'video/mp4' : 'image/jpeg');
        const ext = isVideo ? (mimeType.includes('mp4') ? 'mp4' : 'webm') : (rec.kind === 'pdf' ? 'pdf' : 'jpg');
        const base = sanitizeFilename(rec.name);
        const count = usedNames.get(base) || 0;
        usedNames.set(base, count + 1);
        const filename = count === 0 ? `${base}.${ext}` : `${base}_${count + 1}.${ext}`;
        try {
          const result = await uploadFileToDrive(projectFolderId, filename, rec.blob, mimeType, token);
          rec.driveSynced = true;
          rec.driveFileId = result.id;
          await dbPutAll([rec]);
          synced += 1;
        } catch (e) {
          toast(`Sync stopped: ${e.message || 'upload failed'}`);
          break;
        }
      }
      // Upload sidecar so any device that pulls this project gets categories/names back.
      if (synced > 0) {
        try {
          const allRecords = await getFolderPhotos(currentFolderId);
          await syncMetadataToDrive(projectFolderId, allRecords, token);
        } catch (_) { /* non-critical — photos are already synced */ }
      }
      toast(`Synced ${synced}/${pending.length} item${pending.length === 1 ? '' : 's'} to Drive`);
    } finally {
      els.driveSyncBtn.disabled = false;
      els.driveSyncBtn.textContent = origText;
      refreshGallery();
    }
  }

  if (els.driveConnectBtn) {
    els.driveConnectBtn.addEventListener('click', async () => {
      const token = await getDriveAccessToken({ interactive: true });
      updateDriveStatusUI();
      if (!token) toast('Google Drive sign-in was cancelled or failed');
    });
  }
  if (els.driveDisconnectBtn) {
    els.driveDisconnectBtn.addEventListener('click', disconnectDrive);
  }
  if (els.driveSyncBtn) els.driveSyncBtn.addEventListener('click', syncFolderToDrive);

  // Auto-sync toggle
  const autoSyncBtn = document.getElementById('auto-sync-btn');
  if (autoSyncBtn) {
    applyAutoSyncToggle();
    autoSyncBtn.addEventListener('click', async () => {
      const turningOn = !autoSyncEnabled;
      // Close dropdown first (keeps UI responsive while await runs below)
      const dd = document.getElementById('gallery-menu-dropdown');
      const mb = document.getElementById('gallery-menu-btn');
      if (dd) dd.classList.remove('open');
      if (mb) mb.classList.remove('menu-open');

      if (turningOn) {
        // Request an interactive token NOW, while we still have the user's tap
        // gesture. iOS Safari revokes activation the moment the call stack yields,
        // so this must be the first await. Caching the token here means the
        // background timer can reuse it silently for up to ~1 hour.
        const token = await getDriveAccessToken({ interactive: true });
        if (!token) {
          toast('⏱️ Auto-Sync requires Google Drive sign-in');
          return; // leave auto-sync off
        }
        autoSyncEnabled = true;
        localStorage.setItem(AUTO_SYNC_KEY, '1');
        applyAutoSyncToggle();
        startAutoSync(); // token is cached — immediate run will succeed
        toast(`⏱️ Auto-Sync ON — uploads every ${autoSyncIntervalMin} minute${autoSyncIntervalMin === 1 ? '' : 's'} while app is open`);
      } else {
        autoSyncEnabled = false;
        localStorage.setItem(AUTO_SYNC_KEY, '0');
        applyAutoSyncToggle();
        stopAutoSync();
        toast('⏱️ Auto-Sync OFF');
      }
    });
  }

  // Auto-sync interval picker
  document.querySelectorAll('.sync-interval-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // keep dropdown open
      autoSyncIntervalMin = parseInt(btn.dataset.min, 10);
      localStorage.setItem(AUTO_SYNC_INTERVAL_KEY, String(autoSyncIntervalMin));
      applyAutoSyncToggle();
      if (autoSyncEnabled) {
        startAutoSync(); // restart timer with new interval
        toast(`⏱️ Auto-Sync interval changed to ${autoSyncIntervalMin} min`);
      }
    });
  });

  // Resume auto-sync if it was on before. Skip the immediate run on page load —
  // the in-memory token is gone after a reload, so the first timer tick will
  // attempt a silent refresh; if that fails it shows the reconnect toast.
  if (autoSyncEnabled) startAutoSync({ skipImmediate: true });
  if (els.dskActionDrive) els.dskActionDrive.addEventListener('click', syncFolderToDrive);
  updateDriveStatusUI();

  /* ---------------- Pull from Drive ----------------
     The other half of the bridge: an inspector shoots and voice-names photos on
     their phone, syncs to Drive, then on a desktop picks that same project here
     and pulls its files straight into the local gallery — no manual download +
     drag-and-drop required. Lists the project subfolders actually sitting in
     Drive/Name That Photo (since that's the one list both devices share), rather than
     this device's own (possibly empty) local project list. */
  async function listDriveProjectSubfolders(token) {
    const rootId = await ensureDriveFolder(DRIVE_ROOT_FOLDER_NAME, null, token);
    driveRootFolderId = rootId;
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and '${rootId}' in parents and trashed=false`
    );
    let folders = [];
    let pageToken = '';
    do {
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name),nextPageToken&orderBy=name&pageSize=1000${pageParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      folders = folders.concat(data.files || []);
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return folders;
  }

  async function listDriveFilesInFolder(folderId, token) {
    // Drive's files.list defaults to a max of 100 results per call and returns a
    // nextPageToken when more exist — without paging through it, any project with
    // more than 100 photos silently gets truncated on pull. Page through until
    // nextPageToken is empty so every file actually comes back.
    //
    // Ordered by createdTime (oldest first) rather than name: Sync to Drive uploads
    // photos in capture order, so Drive's own createdTime timestamps track capture
    // order closely. Filenames are the voice-spoken names, not timestamps, so
    // ordering by name scrambles the on-site shooting sequence.
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    let files = [];
    let pageToken = '';
    do {
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,createdTime),nextPageToken&orderBy=createdTime&pageSize=1000${pageParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  async function downloadDriveFile(fileId, token) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
    return res.blob();
  }

  // Reverses sanitizeFilename's underscore-for-space swap so a pulled file's name
  // reads naturally in the gallery. Lossy (any punctuation sanitizeFilename
  // stripped on upload doesn't come back), but matches the original closely enough.
  function nameFromDriveFilename(filename) {
    const base = filename.replace(/\.[a-z0-9]+$/i, '');
    return base.replace(/_/g, ' ').trim() || 'Photo';
  }

  function closeDrivePullModal() {
    els.drivePullModal.classList.remove('active');
  }

  // Finds a local project folder matching this name (case-insensitive), or
  // creates one — handles the common case where this device has never heard of
  // a project that was started on the phone.
  async function findOrCreateLocalFolder(name) {
    const folders = await dbGetAllFolders();
    const match = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (match) return match;
    const folder = { id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5), name, createdAt: Date.now() };
    await dbAddFolder(folder);
    localStorage.setItem(HAS_CREATED_PROJECT_KEY, '1');
    return folder;
  }

  async function pullProjectFromDrive(driveFolderId, projectName, token) {
    els.drivePullStatus.textContent = `Checking "${projectName}"…`;
    els.drivePullList.innerHTML = '';

    const localFolder = await findOrCreateLocalFolder(projectName);
    await switchFolder(localFolder.id, localFolder.name);

    const [driveFiles, localRecords] = await Promise.all([
      listDriveFilesInFolder(driveFolderId, token),
      getFolderPhotos(localFolder.id),
    ]);
    const alreadyPulled = new Set(localRecords.filter((r) => r.driveFileId).map((r) => r.driveFileId));
    // Separate metadata sidecar from actual media files before filtering
    const metaFile = driveFiles.find((f) => f.name === '_metadata.json');
    const photoFiles = driveFiles.filter((f) => f.name !== '_metadata.json');
    const toPull = photoFiles.filter((f) => !alreadyPulled.has(f.id));

    if (!toPull.length) {
      els.drivePullStatus.textContent = photoFiles.length
        ? `All ${photoFiles.length} item${photoFiles.length === 1 ? '' : 's'} already pulled into "${projectName}".`
        : `"${projectName}" has no files in Drive yet.`;
      refreshGallery();
      refreshDesktopSummary();
      return;
    }

    // Load the metadata sidecar so we can restore categories/names on each record
    const metaMap = {};
    if (metaFile) {
      try {
        const metaBlob = await downloadDriveFile(metaFile.id, token);
        const metaEntries = JSON.parse(await metaBlob.text());
        for (const entry of metaEntries) {
          if (entry.driveFileId) metaMap[entry.driveFileId] = entry;
        }
      } catch (_) { /* no metadata — pull without categories */ }
    }

    let pulled = 0;
    for (const file of toPull) {
      els.drivePullStatus.textContent = `Pulling ${pulled + 1}/${toPull.length}…`;
      try {
        const blob = await downloadDriveFile(file.id, token);
        const now = Date.now() + pulled; // keep stable relative order among this batch
        const meta = metaMap[file.id];
        const record = {
          id: 'p_' + now + '_' + Math.random().toString(36).slice(2, 7),
          name: (meta && meta.name) ? meta.name : nameFromDriveFilename(file.name),
          blob,
          createdAt: now,
          order: now,
          folderId: localFolder.id,
          driveFileId: file.id,
          driveSynced: true, // it came from Drive, so it's already there — no need to re-push
        };
        if (file.mimeType && file.mimeType.startsWith('video/')) record.kind = 'video';
        else if (file.mimeType === 'application/pdf') record.kind = 'pdf';
        // Restore preserved metadata fields
        if (meta) {
          if (meta.category) record.category = meta.category;
          if (meta.subLocation) record.subLocation = meta.subLocation;
          if (meta.building) record.building = meta.building;
          if (meta.heading != null) record.heading = meta.heading;
        }
        await dbAdd(record);
        pulled += 1;
      } catch (e) {
        toast(`Pull stopped: ${e.message || 'download failed'}`);
        break;
      }
    }
    els.drivePullStatus.textContent = `Pulled ${pulled}/${toPull.length} item${toPull.length === 1 ? '' : 's'} into "${projectName}".`;
    refreshGallery();
    refreshDesktopSummary();
  }

  async function renderDrivePullList(token) {
    els.drivePullStatus.textContent = 'Loading projects…';
    els.drivePullList.innerHTML = '';
    let projects;
    try {
      projects = await listDriveProjectSubfolders(token);
    } catch (e) {
      els.drivePullStatus.textContent = 'Could not load Drive projects. Try again.';
      return;
    }
    if (!projects.length) {
      els.drivePullStatus.textContent = 'No projects found in Drive/Name That Photo yet. Sync a project from a phone first.';
      return;
    }
    els.drivePullStatus.textContent = 'Pick a project to pull down:';
    for (const p of projects) {
      const row = document.createElement('div');
      row.className = 'drive-pull-row';
      const nameEl = document.createElement('div');
      nameEl.className = 'drive-pull-row-name';
      nameEl.textContent = p.name;
      const tagEl = document.createElement('div');
      tagEl.className = 'drive-pull-row-tag';
      tagEl.textContent = 'Pull ⬇️';
      row.appendChild(nameEl);
      row.appendChild(tagEl);
      row.addEventListener('click', () => pullProjectFromDrive(p.id, p.name, token));
      els.drivePullList.appendChild(row);
    }
  }

  async function openDrivePullModal() {
    els.drivePullModal.classList.add('active');
    els.drivePullStatus.textContent = 'Connecting to Google Drive…';
    els.drivePullList.innerHTML = '';
    const token = await getDriveAccessToken({ interactive: true });
    updateDriveStatusUI();
    if (!token) {
      els.drivePullStatus.textContent = 'Google Drive sign-in was cancelled or failed.';
      return;
    }
    renderDrivePullList(token);
  }

  if (els.dskActionDrivePull) els.dskActionDrivePull.addEventListener('click', openDrivePullModal);
  if (els.drivePullBtn) els.drivePullBtn.addEventListener('click', openDrivePullModal);
  if (els.drivePullClose) els.drivePullClose.addEventListener('click', closeDrivePullModal);

  /* ---------------- Send Link (share a project's Drive folder) ----------------
     Gives anyone — a desk reviewer, a homeowner, another inspector — direct
     access to a project's synced photos without using this app at all. Sets the
     project's Drive folder to "anyone with the link can view" the first time
     it's shared, then hands off the resulting Drive URL through the normal
     share sheet (same navigator.share/clipboard pattern as Live View's "Send
     link to homeowner"). Only ever touches the one project folder this app
     created — never the rest of anyone's Drive. */
  async function makeDriveFolderLinkShareable(folderId, token) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions?fields=id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
    return `https://drive.google.com/drive/folders/${folderId}`;
  }

  function shareDriveLink(url, projectName) {
    if (navigator.share) {
      navigator.share({ title: `${projectName} — Photos`, url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url)
        .then(() => toast('Link copied — send it to whoever needs the photos'))
        .catch(() => toast('Link: ' + url));
    } else {
      toast('Link: ' + url);
    }
  }

  async function sendProjectDriveLink() {
    const records = await getFolderPhotos(currentFolderId);
    const synced = records.filter((r) => r.driveSynced);
    if (!synced.length) {
      toast('Sync this project to Drive first, then send the link');
      return;
    }

    const token = await getDriveAccessToken({ interactive: true });
    if (!token) { toast('Google Drive sign-in was cancelled or failed'); return; }
    updateDriveStatusUI();

    try {
      if (!driveRootFolderId) driveRootFolderId = await ensureDriveFolder(DRIVE_ROOT_FOLDER_NAME, null, token);
      const projectFolderId = await ensureDriveFolder(currentFolderName || 'Untitled Project', driveRootFolderId, token);
      const url = await makeDriveFolderLinkShareable(projectFolderId, token);
      shareDriveLink(url, currentFolderName || 'Untitled Project');
    } catch (e) {
      toast(`Couldn't create link: ${e.message || 'try again'}`);
    }
  }

  if (els.dskActionDriveLink) els.dskActionDriveLink.addEventListener('click', sendProjectDriveLink);
  if (els.driveLinkBtn) els.driveLinkBtn.addEventListener('click', sendProjectDriveLink);

  function updateFolderChip() {
    const hasCreated = localStorage.getItem(HAS_CREATED_PROJECT_KEY) === '1';
    if (els.projectBannerLabel) {
      els.projectBannerLabel.textContent = hasCreated ? 'Current Project' : 'Create Project';
    }
    if (els.projectBannerName) {
      els.projectBannerName.textContent = hasCreated ? (currentFolderName || '') : '';
      els.projectBannerName.style.display = hasCreated ? '' : 'none';
    }
    // Open in create-focused mode before any project exists; switch mode after
    if (els.projectBanner) {
      els.projectBanner.onclick = () => openFoldersModal(!hasCreated);
    }
  }

  // Switches the active property. Clears any in-progress select/reorder state
  // so selections never leak across properties, then re-renders the gallery.
  async function switchFolder(folderId, name) {
    currentFolderId = folderId;
    currentFolderName = name;
    localStorage.setItem(CURRENT_FOLDER_KEY, folderId);
    updateFolderChip();
    activeBuildingFilter = null;
    loadBuildingState(currentFolderId);
    updateBuildingReadout();
    renderBuildingFilterBar();

    selectMode = false;
    selectedIds.clear();
    reorderMode = false;
    reorderSelected.clear();
    els.selectBtn.classList.remove('active');
    els.selectBtn.textContent = 'Select';
    els.reorderBtn.classList.remove('active');
    els.reorderBtn.textContent = 'Rearrange Photos';
    els.bulkBar.classList.remove('active');
    els.grid.classList.remove('select-mode', 'reorder-mode');
    pdfTitleAutoFilled = true;
    gallerySearchQuery = '';
    els.gallerySearch.value = '';

    if (els.galleryView.classList.contains('active')) refreshGallery();
  }

  async function renderFoldersList() {
    const allFolders = await dbGetAllFolders();
    const allPhotos = await dbGetAll();
    const counts = new Map();
    allPhotos.forEach((p) => counts.set(p.folderId, (counts.get(p.folderId) || 0) + 1));

    // Hide the auto-created holding folder until it actually has photos in it — the
    // list should only ever show projects the user has named themselves.
    const realFolders = allFolders.filter((f) => !f.isDefault || (counts.get(f.id) || 0) > 0);

    // Filter by the search box (case-insensitive substring match on project name).
    // Counts above are computed from the full, unfiltered photo set either way.
    const folders = folderSearchQuery
      ? realFolders.filter((f) => f.name.toLowerCase().includes(folderSearchQuery))
      : realFolders;

    els.foldersList.innerHTML = '';
    if (!realFolders.length) {
      els.foldersList.innerHTML = '<div id="folders-empty">No projects yet</div>';
      return;
    }
    if (!folders.length) {
      els.foldersList.innerHTML = '<div id="folders-empty">No projects match your search</div>';
      return;
    }

    folders.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'folder-row' + (f.id === currentFolderId ? ' current' : '');

      const main = document.createElement('div');
      main.className = 'folder-row-main';
      const nameEl = document.createElement('div');
      nameEl.className = 'folder-row-name';
      nameEl.textContent = f.name;
      const countEl = document.createElement('div');
      countEl.className = 'folder-row-count';
      const n = counts.get(f.id) || 0;
      countEl.textContent = n + (n === 1 ? ' photo' : ' photos');
      main.appendChild(nameEl);
      main.appendChild(countEl);

      const renameBtn = document.createElement('button');
      renameBtn.textContent = '✎';
      renameBtn.title = 'Rename';
      renameBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newName = prompt('Rename project:', f.name);
        if (newName && newName.trim()) {
          f.name = newName.trim();
          await dbAddFolder(f);
          if (f.id === currentFolderId) { currentFolderName = f.name; updateFolderChip(); }
          renderFoldersList();
        }
      });

      // Sets which compass direction the front of THIS property faces — used to
      // auto-suggest Front/Right/Rear/Left on exterior photos from their stamped
      // heading. Stored per-folder since every property faces a different way.
      const compassBtn = document.createElement('button');
      compassBtn.textContent = '🧭';
      compassBtn.title = f.frontFacing ? `Front faces ${f.frontFacing} — tap to change` : 'Set which way the front faces';
      compassBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const result = await openFrontFacingPicker(f);
        if (result === undefined) return; // cancelled — leave f.frontFacing untouched
        if (result === null) {
          delete f.frontFacing;
        } else {
          f.frontFacing = result;
        }
        await dbAddFolder(f);
        renderFoldersList();
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'folder-del';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const count = counts.get(f.id) || 0;
        const msg = count
          ? `Delete "${f.name}" and its ${count} photo${count === 1 ? '' : 's'}? This cannot be undone.`
          : `Delete "${f.name}"?`;
        if (!confirm(msg)) return;

        const photosToDelete = allPhotos.filter((p) => p.folderId === f.id);
        for (const p of photosToDelete) await dbDelete(p.id);
        await dbDeleteFolder(f.id);

        let remaining = await dbGetAllFolders();
        if (!remaining.length) {
          const def = { id: 'f_' + Date.now(), name: 'My Inspection', createdAt: Date.now(), isDefault: true };
          await dbAddFolder(def);
          remaining = [def];
        }
        if (f.id === currentFolderId) {
          await switchFolder(remaining[0].id, remaining[0].name);
        }
        renderFoldersList();
        refreshGallery();
      });

      row.appendChild(main);
      row.appendChild(renameBtn);
      row.appendChild(compassBtn);
      row.appendChild(delBtn);
      row.addEventListener('click', () => {
        switchFolder(f.id, f.name);
        closeFoldersModal();
        offerCameraStartIfNeeded();
      });
      els.foldersList.appendChild(row);
    });
  }

  // focusNewProject: true opens the modal with focus straight on the "Create New Project"
  // input (used by the Create New Project pill), instead of the search field (default).
  function openFoldersModal(focusNewProject) {
    const hasCreatedNow = localStorage.getItem(HAS_CREATED_PROJECT_KEY) === '1';
    els.newFolderInput.value = '';
    els.foldersSearch.value = '';
    folderSearchQuery = '';
    renderFoldersList();
    els.foldersModal.classList.add('active');
    setTimeout(() => {
      if (focusNewProject) {
        els.newFolderInput.focus();
      } else els.foldersSearch.focus();
    }, 50);
  }

  function closeFoldersModal() {
    els.foldersModal.classList.remove('active');
  }

  if (els.projectBanner) els.projectBanner.addEventListener('click', () => openFoldersModal(false));
  els.foldersClose.addEventListener('click', closeFoldersModal);

  const foldersRetrieveCloud = document.getElementById('folders-retrieve-cloud');
  if (foldersRetrieveCloud) {
    foldersRetrieveCloud.addEventListener('click', () => {
      closeFoldersModal();
      openDrivePullModal();
    });
  }
  els.foldersSearch.addEventListener('input', () => {
    folderSearchQuery = els.foldersSearch.value.trim().toLowerCase();
    renderFoldersList();
  });
  attachDictation(els.newFolderMic, els.newFolderInput);
  attachDictation(els.foldersSearchMic, els.foldersSearch);

  els.gallerySearch.addEventListener('input', () => {
    gallerySearchQuery = els.gallerySearch.value.trim().toLowerCase();
    refreshGallery();
  });
  attachDictation(els.gallerySearchMic, els.gallerySearch);

  // Creates a new project folder and switches to it. Shared by both entry points:
  // the "+" quick button in the camera view, and the Projects list's "Add & Switch".
  async function createProject(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const folder = { id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5), name: trimmed, createdAt: Date.now() };
    await dbAddFolder(folder);
    localStorage.setItem(HAS_CREATED_PROJECT_KEY, '1');
    await switchFolder(folder.id, folder.name);
  }

  els.newFolderAdd.addEventListener('click', async () => {
    const name = els.newFolderInput.value.trim();
    if (!name) { alert('Enter a project name.'); return; }
    // switchFolder() (called inside createProject) sets currentFolderId as its very
    // first statement, before any other work — so the active project changes
    // immediately even if something later in that chain throws. Without this
    // try/finally, a throw would skip closeFoldersModal() entirely, leaving the
    // Projects list open and stuck showing whichever project was "current" when the
    // list was first rendered (the old project) instead of the one just created —
    // exactly the "still highlighting a different project" bug, since the list's
    // blue outline is computed once per render and nothing forces a re-render here.
    // renderFoldersList() guarantees the highlight reflects the new currentFolderId
    // regardless of whether the modal ends up staying open or closing right after.
    try {
      await createProject(name);
    } catch (e) {
      console.error('createProject failed', e);
    }
    renderFoldersList();
    closeFoldersModal();
    offerCameraStartIfNeeded();
  });

  // The old quick "+" button (#new-project-btn) was removed — #create-project-pill
  // (wired above via openFoldersModal(true)) covers the same action.

  /* ---------------- Compass ---------------- */
  // Off by default every time the app opens — toggled on/off per shot by the user.
  let compassOn = false;
  let compassHeading = null; // last known heading in degrees, 0 = true/magnetic north

  function cardinal(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  // Inverse of cardinal() — used to turn a property's saved "front faces ___"
  // direction back into degrees so it can be compared against a photo's heading.
  const CARDINAL_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

  // Given a photo's compass heading and the property's front-facing direction, suggests
  // which elevation (Front/Right/Rear/Left) the photo was most likely taken from. "Right"/
  // "Left" follow a clockwise walk around the building starting at the front — i.e. Right
  // elevation is ~90° clockwise from Front. This is a starting suggestion only; the
  // inspector always taps to confirm or override it, so a wrong guess never reaches the report
  // un-reviewed.
  function suggestElevation(heading, frontFacing) {
    if (heading == null || !frontFacing || !(frontFacing in CARDINAL_DEG)) return null;
    const diff = ((heading - CARDINAL_DEG[frontFacing]) % 360 + 360) % 360;
    if (diff <= 45 || diff >= 315) return 'Front';
    if (diff > 45 && diff <= 135) return 'Right';
    if (diff > 135 && diff <= 225) return 'Rear';
    return 'Left';
  }

  async function getCurrentFolderFrontFacing() {
    const folders = await dbGetAllFolders();
    const f = folders.find((x) => x.id === currentFolderId);
    return (f && f.frontFacing) || null;
  }

  function handleOrientation(e) {
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') {
      heading = e.webkitCompassHeading; // iOS Safari gives true heading directly
    } else if (typeof e.alpha === 'number') {
      heading = 360 - e.alpha; // Android/other: best-effort absolute heading
    }
    if (heading == null || Number.isNaN(heading)) return;
    heading = ((heading % 360) + 360) % 360;
    compassHeading = heading;
    if (compassOn) {
      els.compassReadout.textContent = cardinal(heading) + ' ' + Math.round(heading) + '°';
    }
  }

  async function enableCompass() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result !== 'granted') {
          alert('Compass needs Motion & Orientation access. Enable it in Settings > Safari > Motion & Orientation Access, then try again.');
          return false;
        }
      } catch (err) {
        alert('Could not get compass permission.');
        return false;
      }
    }
    window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    window.addEventListener('deviceorientation', handleOrientation, true);
    return true;
  }

  function disableCompass() {
    window.removeEventListener('deviceorientationabsolute', handleOrientation, true);
    window.removeEventListener('deviceorientation', handleOrientation, true);
    compassHeading = null;
  }

  if (els.buildingToggle) els.buildingToggle.addEventListener('click', openBuildingsModal);

  // Silent mode toggle — disables voice labeling for noisy environments
  function applySilentToggleState() {
    if (!els.silentToggle) return;
    els.silentToggle.classList.toggle('active', silentMode);
    els.silentToggle.title = silentMode
      ? 'Silent mode ON — photos auto-saved without voice labeling. Tap to re-enable.'
      : 'Silent mode OFF — tap to disable voice labeling (useful in noisy environments).';
    els.silentToggle.textContent = silentMode ? '🔇' : '🎙️';
  }
  if (els.silentToggle) {
    applySilentToggleState();
    els.silentToggle.addEventListener('click', () => {
      silentMode = !silentMode;
      localStorage.setItem(SILENT_MODE_KEY, silentMode ? '1' : '0');
      silentPhotoCount = 0; // reset counter each time mode switches
      applySilentToggleState();
      toast(silentMode
        ? '🔇 Silent mode ON — photos will auto-save without voice labeling'
        : '🎙️ Voice labeling re-enabled');
    });
  }
  if (els.galleryBuildingBtn) els.galleryBuildingBtn.addEventListener('click', openBuildingsModal);
  if (els.buildingsClose) els.buildingsClose.addEventListener('click', closeBuildingsModal);
  if (els.newBuildingAdd) els.newBuildingAdd.addEventListener('click', addBuildingFromInput);
  attachDictation(els.newBuildingMic, els.newBuildingInput);

  els.compassToggle.addEventListener('click', async () => {
    if (compassOn) {
      compassOn = false;
      disableCompass();
      els.compassToggle.classList.remove('active');
      els.compassReadout.classList.add('hidden');
      return;
    }
    const ok = await enableCompass();
    if (!ok) return;
    compassOn = true;
    els.compassToggle.classList.add('active');
    els.compassReadout.classList.remove('hidden');
    els.compassReadout.textContent = 'Finding heading…';
  });

  // Lets the inspector set a project's front-facing direction by literally standing facing
  // the front and reading the live device compass, instead of guessing a letter from memory.
  // Reuses the same enableCompass()/disableCompass()/compassHeading machinery as the camera
  // view's compass toggle. Built once and reused (overlay just shows/hides) rather than
  // rebuilt per call.
  let ffModalEls = null;
  function buildFrontFacingModal() {
    if (ffModalEls) return ffModalEls;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:300;display:none;align-items:center;justify-content:center;padding:20px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1c1c1e;border:1px solid #444;border-radius:14px;padding:20px;max-width:340px;width:100%;color:#fff;font-family:inherit;';
    box.innerHTML =
      '<div style="font-size:16px;font-weight:700;margin-bottom:6px;">Which way does the front face?</div>' +
      '<div style="font-size:13px;color:#aaa;margin-bottom:14px;">Stand facing the front of the property, then tap the heading below — or pick a direction manually.</div>' +
      '<div id="ff-readout" style="font-size:28px;font-weight:700;text-align:center;margin-bottom:6px;">—</div>' +
      '<div id="ff-readout-sub" style="font-size:12px;color:#888;text-align:center;margin-bottom:14px;">Finding heading…</div>' +
      '<div id="ff-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px;"></div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button id="ff-cancel" style="flex:1;padding:10px 0;border-radius:10px;border:1px solid #555;background:transparent;color:#fff;font-size:13px;">Cancel</button>' +
      '<button id="ff-clear" style="flex:1;padding:10px 0;border-radius:10px;border:1px solid #555;background:transparent;color:#fff;font-size:13px;">Clear</button>' +
      '<button id="ff-save" style="flex:1;padding:10px 0;border-radius:10px;border:none;background:#0a84ff;color:#fff;font-size:13px;font-weight:700;" disabled>Save</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const grid = box.querySelector('#ff-grid');
    const dirBtns = {};
    ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].forEach((d) => {
      const b = document.createElement('button');
      b.textContent = d;
      b.dataset.dir = d;
      b.style.cssText = 'padding:10px 0;border-radius:10px;border:1px solid #555;background:#2c2c2e;color:#fff;font-size:13px;font-weight:600;';
      grid.appendChild(b);
      dirBtns[d] = b;
    });
    ffModalEls = {
      overlay, dirBtns,
      readout: box.querySelector('#ff-readout'),
      readoutSub: box.querySelector('#ff-readout-sub'),
      cancelBtn: box.querySelector('#ff-cancel'),
      clearBtn: box.querySelector('#ff-clear'),
      saveBtn: box.querySelector('#ff-save'),
    };
    return ffModalEls;
  }

  // Resolves to: a cardinal string (Save), null (Clear — removes frontFacing), or
  // undefined (Cancel — leaves the folder's existing frontFacing untouched).
  async function openFrontFacingPicker(folder) {
    const m = buildFrontFacingModal();
    let selected = folder.frontFacing || null;

    function renderSelection() {
      Object.entries(m.dirBtns).forEach(([d, btn]) => {
        const isSel = d === selected;
        btn.style.background = isSel ? '#0a84ff' : '#2c2c2e';
        btn.style.borderColor = isSel ? '#0a84ff' : '#555';
      });
      m.saveBtn.disabled = !selected;
      m.saveBtn.style.opacity = selected ? '1' : '.5';
    }
    Object.values(m.dirBtns).forEach((btn) => {
      btn.onclick = () => { selected = btn.dataset.dir; renderSelection(); };
    });

    // Only start the listeners if nothing else has them running (the camera view's compass
    // toggle may already be on). Only WE stop them on close — never cut off a heading the
    // camera-view toggle is actively using to stamp photos.
    let weStartedListening = false;
    if (!compassOn) {
      const ok = await enableCompass();
      if (ok) weStartedListening = true;
    }
    m.readoutSub.textContent = (compassOn || weStartedListening)
      ? 'Live heading — tap to use it'
      : 'Compass unavailable — pick a direction manually.';

    function pollHeading() {
      if (compassHeading != null) {
        m.readout.textContent = cardinal(compassHeading) + ' ' + Math.round(compassHeading) + '°';
        m.readout.style.cursor = 'pointer';
        m.readout.onclick = () => { selected = cardinal(compassHeading); renderSelection(); };
      }
    }
    pollHeading();
    const pollTimer = setInterval(pollHeading, 300);

    renderSelection();
    m.overlay.style.display = 'flex';

    return new Promise((resolve) => {
      function cleanup(value) {
        clearInterval(pollTimer);
        m.overlay.style.display = 'none';
        m.readout.onclick = null;
        m.cancelBtn.onclick = null;
        m.clearBtn.onclick = null;
        m.saveBtn.onclick = null;
        if (weStartedListening) disableCompass();
        resolve(value);
      }
      m.cancelBtn.onclick = () => cleanup(undefined);
      m.clearBtn.onclick = () => cleanup(null);
      m.saveBtn.onclick = () => { if (selected) cleanup(selected); };
    });
  }

  // Draws a "Facing NE (42°)" label into the bottom-left corner of a just-captured
  // photo, baked into the pixels so it travels with the image into reports/exports.
  function stampCompass(ctx, w, h, heading) {
    const label = 'Facing ' + cardinal(heading) + ' (' + Math.round(heading) + '°)';
    const fontSize = Math.max(18, Math.round(w * 0.032));
    const pad = Math.round(fontSize * 0.6);
    ctx.font = '600 ' + fontSize + 'px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    const textW = ctx.measureText(label).width;
    const boxW = textW + pad * 2;
    const boxH = fontSize + pad * 1.6;
    const x = pad;
    const y = h - pad - boxH;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, y, boxW, boxH);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + pad, y + boxH - pad * 0.9);
  }

  /* ---------------- Camera ---------------- */
  // els.video itself is never shown on screen (parked off-screen via CSS) — what the
  // user sees is els.previewCanvas, hand-painted every frame from that hidden video
  // by drawFrame() below. iOS flashes a native play/pause icon on any *visible*
  // autoplaying <video>, and that overlay lives in a system compositing layer no
  // amount of CSS (pseudo-elements, opacity, a sibling cover div — all tried) can
  // block. Keeping the real <video> off-screen sidesteps the problem entirely:
  // there's nothing for the OS to draw the icon on top of where the user can see it.
  const previewCtx = els.previewCanvas.getContext('2d');
  let drawLoopActive = false;

  function drawFrame() {
    if (!drawLoopActive) return;
    const vw = els.video.videoWidth, vh = els.video.videoHeight;
    if (vw && vh) {
      const cw = els.previewCanvas.width, ch = els.previewCanvas.height;
      // Mimics CSS object-fit:cover — scale to fill, crop whichever axis overflows.
      const scale = Math.max(cw / vw, ch / vh);
      const dw = vw * scale, dh = vh * scale;
      previewCtx.drawImage(els.video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    }
    requestAnimationFrame(drawFrame);
  }

  function resizePreviewCanvas() {
    const dpr = window.devicePixelRatio || 1;
    els.previewCanvas.width = Math.round(els.previewCanvas.clientWidth * dpr);
    els.previewCanvas.height = Math.round(els.previewCanvas.clientHeight * dpr);
  }
  window.addEventListener('resize', resizePreviewCanvas);

  async function startCamera() {
    await stopCamera();
    // getUserMedia + the video element's first real frame both take a beat — if the
    // shutter is tapped in that window (most likely right after a flow that jumps
    // straight from another screen into the camera, e.g. Save & Start Camera),
    // capturePhoto() reads video.videoWidth/Height before either is ready and either
    // saves a blank frame or the same stale frame on every subsequent tap. Disable the
    // shutter until the stream actually has a frame, so every capture is a real one.
    if (els.shutter) els.shutter.disabled = true;
    els.camStatus.textContent = 'Starting camera…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      els.video.srcObject = stream;
      lastFrameSignature = null; // fresh stream — don't compare against a frame from the old one
      els.video.onloadedmetadata = () => {
        if (els.shutter) els.shutter.disabled = false;
        els.camStatus.textContent = '';
      };
      els.video.play().catch(() => {});
      resizePreviewCanvas();
      drawLoopActive = true;
      requestAnimationFrame(drawFrame);
      // iOS occasionally suspends or kills the video track mid-session (thermal/resource
      // pressure, Siri, a phone call) without the page getting an error — the <video>
      // element just keeps showing its last frame forever. mute/ended fire when that
      // happens; lock the shutter and recover automatically instead of leaving the user
      // capturing the same frozen frame on every tap.
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.onmute = () => {
          if (els.shutter) els.shutter.disabled = true;
          els.camStatus.textContent = 'Camera paused — reconnecting…';
        };
        track.onunmute = () => {
          if (els.shutter) els.shutter.disabled = false;
          els.camStatus.textContent = '';
        };
        track.onended = () => {
          if (!els.cameraView.classList.contains('hidden')) startCamera();
        };
      }
    } catch (err) {
      if (els.shutter) els.shutter.disabled = false; // don't strand the user behind a dead button
      els.camStatus.textContent = 'Camera access denied or unavailable. Check Settings > Safari > Camera.';
      console.error(err);
    }
  }

  async function stopCamera() {
    // stopLiveView awaits the recorder's stop()/flush before returning — must finish
    // before we touch the track below, since the recorder is encoding this exact
    // track object. Stopping it early truncates the file mid-write.
    if (liveActive) await stopLiveView();
    drawLoopActive = false;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
  }

  // iOS snapshots the page when the app is backgrounded and briefly shows that
  // snapshot again on relaunch. Tearing the camera down on background and restarting
  // it on return keeps that snapshot from showing a frozen/stale frame.
  document.addEventListener('visibilitychange', () => {
    const cameraActive = !els.cameraView.classList.contains('hidden');
    if (document.visibilityState === 'hidden') {
      if (cameraActive) stopCamera();
    } else if (document.visibilityState === 'visible' && cameraActive) {
      // Don't auto-restart into a still-gated state (no project yet) or while the
      // post-creation "Start Camera?" prompt is up awaiting a tap.
      if (hasRealProject() && !isDesktopDevice() && els.cameraStartPrompt.classList.contains('hidden')) {
        startCamera();
      }
    }
  });

  els.flipCam.addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    const wasLive = liveActive;
    if (wasLive) stopLiveView(); // flipping swaps the camera track out from under the active call
    startCamera();
    if (wasLive) toast('Live view ended — flipping the camera stops it. Tap Go Live to restart.');
  });

  /* ---------------- Live View (homeowner can watch in real time) ---------------- */
  // Uses Daily.co's WebRTC platform. The homeowner needs no app or account — they
  // just open a plain link in any browser. We reuse the SAME camera track already
  // powering the shutter/preview (passed in as videoSource) instead of letting Daily
  // request its own getUserMedia stream, since iOS Safari won't reliably run two
  // concurrent camera sessions. Taking photos keeps working unaffected — capturePhoto()
  // just reads a frame off the shared <video> element, same as always.
  // Each inspector's room is their own — stored locally on this device only, never
  // hardcoded — so two different inspectors using this app never land in the same room.
  const LIVE_ROOM_KEY = 'pn_liveRoomUrl';
  let dailyCall = null;
  let liveActive = false;
  let liveAutoStartAfterSetup = false;
  let liveMicStream = null;
  // Desk-side ("Watch Live") call-object state — separate from the inspector's dailyCall above.
  let watchCall = null;
  let watchMicStream = null;
  let watchMuted = false;
  let lastPointerSendAt = 0;
  // Tracks the desk viewer's own last pointer position/visibility, so Capture can bake
  // the arrow into the saved photo exactly where it was pointing — the dot itself only
  // exists as a DOM overlay on the inspector's screen and is never part of the actual
  // video frame data, so without this the captured photo would never show it.
  let lastPointerNx = 0.5, lastPointerNy = 0.5, lastPointerVisible = false;
  const remoteAudioEls = new Map(); // session_id -> <audio> element playing that person's mic
  const remoteMixNodes = new Map(); // session_id -> AudioNode feeding that person's mic into the recording mix

  // Recording state: combines the inspector's camera + mic with the homeowner's incoming
  // voice into one mixed-audio video file, recorded entirely on-device (no cloud, no cost).
  let recAudioCtx = null;
  let recMixDest = null;
  let recLocalMicNode = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;

  function setupRecordingAudioGraph(localMicTrack) {
    try {
      recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      recMixDest = recAudioCtx.createMediaStreamDestination();
      if (localMicTrack) {
        recLocalMicNode = recAudioCtx.createMediaStreamSource(new MediaStream([localMicTrack]));
        recLocalMicNode.connect(recMixDest);
      }
    } catch (err) {
      console.error(err);
      recAudioCtx = null;
      recMixDest = null;
    }
  }

  function teardownRecordingAudioGraph() {
    remoteMixNodes.forEach((node) => { try { node.disconnect(); } catch (e) {} });
    remoteMixNodes.clear();
    if (recLocalMicNode) { try { recLocalMicNode.disconnect(); } catch (e) {} recLocalMicNode = null; }
    if (recAudioCtx) { try { recAudioCtx.close(); } catch (e) {} recAudioCtx = null; }
    recMixDest = null;
  }

  // Lets the inspector hear the homeowner if they talk back — the call object is headless
  // (no built-in UI), so without this, incoming audio would reach the room but never play.
  // Also feeds that same audio into the recording mix, if recording is in use.
  function attachRemoteAudioHandlers(call) {
    call.on('track-started', (ev) => {
      if (!ev.participant || ev.participant.local || !ev.track || ev.track.kind !== 'audio') return;
      let audioEl = remoteAudioEls.get(ev.participant.session_id);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        document.body.appendChild(audioEl);
        remoteAudioEls.set(ev.participant.session_id, audioEl);
      }
      audioEl.srcObject = new MediaStream([ev.track]);
      audioEl.play().catch(() => {}); // iOS may need this nudge even with autoplay set

      if (recAudioCtx && recMixDest) {
        try {
          const node = recAudioCtx.createMediaStreamSource(new MediaStream([ev.track]));
          node.connect(recMixDest);
          remoteMixNodes.set(ev.participant.session_id, node);
        } catch (err) { console.error(err); }
      }
    });
    call.on('participant-left', (ev) => {
      const id = ev.participant && ev.participant.session_id;
      const audioEl = remoteAudioEls.get(id);
      if (audioEl) { audioEl.remove(); remoteAudioEls.delete(id); }
      const node = remoteMixNodes.get(id);
      if (node) { try { node.disconnect(); } catch (e) {} remoteMixNodes.delete(id); }
    });
  }

  // Lets the desk viewer (Watch Live) point at something on this inspector's screen.
  // The desk side sends normalized (0-1) coordinates measured against the FULL, uncropped
  // camera frame (the same frame this device broadcasts). This device's own on-screen
  // preview is cropped tighter than that full frame (object-fit:cover via drawFrame()),
  // so the normalized point is re-mapped through that same cover-crop math before
  // positioning the dot — otherwise it would land in the wrong spot whenever the visible
  // preview is cropped differently than the desk viewer's full-frame view.
  function attachPointerHandler(call) {
    call.on('app-message', (ev) => {
      const data = ev.data;
      console.log('[watch-live] app-message received', data);
      if (!data || data.type !== 'pointer') return;
      if (!data.visible) { els.livePointerDot.classList.add('hidden'); return; }
      const vw = els.video.videoWidth, vh = els.video.videoHeight;
      const cw = els.previewCanvas.width, ch = els.previewCanvas.height;
      if (!vw || !vh || !cw || !ch) {
        console.warn('[watch-live] pointer skipped — missing dimensions', { vw, vh, cw, ch });
        return;
      }
      const scale = Math.max(cw / vw, ch / vh);
      const dx = (cw - vw * scale) / 2, dy = (ch - vh * scale) / 2;
      const dpr = window.devicePixelRatio || 1;
      const left = (data.nx * vw * scale + dx) / dpr;
      const top = (data.ny * vh * scale + dy) / dpr;
      els.livePointerDot.style.left = left + 'px';
      els.livePointerDot.style.top = top + 'px';
      els.livePointerDot.classList.remove('hidden');
    });
  }

  function clearRemoteAudio() {
    remoteAudioEls.forEach((el) => el.remove());
    remoteAudioEls.clear();
  }

  function startRecording() {
    if (!liveActive || !stream) { toast('Go live first'); return; }
    if (!recMixDest) { toast('Recording isn’t available on this device/browser'); return; }
    try {
      const videoTrack = stream.getVideoTracks()[0];
      const mixedAudioTrack = recMixDest.stream.getAudioTracks()[0];
      const recordingStream = new MediaStream([videoTrack, mixedAudioTrack]);
      let options = { mimeType: 'video/mp4' };
      if (!(window.MediaRecorder && MediaRecorder.isTypeSupported(options.mimeType))) options = {};
      mediaRecorder = new MediaRecorder(recordingStream, options);
      recordedChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
      mediaRecorder.onstop = saveRecording;
      mediaRecorder.start();
      isRecording = true;
      els.liveRecordBtn.classList.add('recording');
      els.liveRecordBtn.textContent = '⏹ Stop';
      toast('Recording started');
    } catch (err) {
      console.error(err);
      toast('Could not start recording on this device');
    }
  }

  // Returns a promise that resolves once the recording has actually stopped and been
  // saved — callers that are about to tear down the underlying audio graph (stopLiveView)
  // must wait for this, or the last buffered chunk can be lost/corrupted mid-flush.
  function stopRecording() {
    return new Promise((resolve) => {
      isRecording = false;
      els.liveRecordBtn.classList.remove('recording');
      els.liveRecordBtn.textContent = '⏺ Record';
      if (!mediaRecorder || mediaRecorder.state === 'inactive') { resolve(); return; }
      mediaRecorder.onstop = async () => { await saveRecording(); resolve(); };
      mediaRecorder.stop();
    });
  }

  // Saves the finished recording straight into the same gallery/IndexedDB store used for
  // photos (tagged kind:'video') — so it shows up alongside this inspection's photos,
  // can be renamed/deleted/exported the same way, and is never dropped into Downloads
  // where it'd be easy to lose track of before building the claim package.
  async function saveRecording() {
    if (!recordedChunks.length) { toast('No recording captured'); return; }
    const mimeType = (mediaRecorder && mediaRecorder.mimeType) || 'video/mp4';
    const blob = new Blob(recordedChunks, { type: mimeType });
    recordedChunks = [];
    const now = Date.now();
    const record = {
      id: 'rec_' + now + '_' + Math.random().toString(36).slice(2, 7),
      kind: 'video',
      name: 'Live recording — ' + new Date(now).toLocaleString(),
      blob,
      createdAt: now,
      order: now,
      folderId: currentFolderId,
    };
    try {
      await dbAdd(record);
      refreshGallery();
      toast('Recording saved to gallery — rename it from there');
    } catch (err) {
      console.error(err);
      toast('Could not save recording — try again');
    }
  }

  els.liveRecordBtn.addEventListener('click', () => {
    if (isRecording) stopRecording(); else startRecording();
  });

  function getLiveRoomUrl() {
    return (localStorage.getItem(LIVE_ROOM_KEY) || '').trim();
  }

  // Mirrors this device's room onto the signed-in account's Firestore doc (best-effort —
  // failures are logged, never block going live) so any other device on the SAME account
  // (e.g. the desk computer) can find it via Watch Live without anyone typing a link.
  function syncLiveRoomToAccount(url) {
    if (!window.fbSetLiveRoom || !currentFirebaseUser) return;
    window.fbSetLiveRoom(currentFirebaseUser.uid, url).catch((err) => console.error(err));
  }

  function isValidDailyUrl(url) {
    return /^https:\/\/[a-z0-9-]+\.daily\.co\/[a-z0-9-]+\/?$/i.test(url);
  }

  function openLiveSetup(autoStart) {
    liveAutoStartAfterSetup = !!autoStart;
    els.liveRoomInput.value = getLiveRoomUrl();
    els.liveSetupModal.classList.add('active');
  }

  function closeLiveSetup() {
    els.liveSetupModal.classList.remove('active');
  }

  // The app itself is hosted on GoDaddy (namethatphoto.com), but the room-creation
  // function lives on a separate, free Netlify site — that's the only place that holds
  // the Daily.co API key. Replace this with your real Netlify site's URL once it's live,
  // e.g. 'https://your-site-name.netlify.app/.netlify/functions/create-room'.
  const ROOM_FUNCTION_URL = 'https://dapper-hummingbird-736d0d.netlify.app/.netlify/functions/create-room';

  // Calls that function, which holds the Daily.co API key server-side and creates a
  // brand-new room. Used both for first-time auto setup and "Generate new".
  async function provisionRoom() {
    const res = await fetch(ROOM_FUNCTION_URL, { method: 'POST' });
    if (!res.ok) throw new Error('Room creation request failed (' + res.status + ')');
    const data = await res.json();
    if (!data.url) throw new Error('No room URL returned');
    return data.url;
  }

  els.liveSetupBtn.addEventListener('click', () => openLiveSetup(false));
  els.liveSetupCancel.addEventListener('click', closeLiveSetup);

  els.liveSetupGenerate.addEventListener('click', async () => {
    els.liveSetupGenerate.disabled = true;
    toast('Creating a new room…');
    try {
      const url = await provisionRoom();
      localStorage.setItem(LIVE_ROOM_KEY, url);
      syncLiveRoomToAccount(url);
      els.liveRoomInput.value = url;
      toast('New room created and saved');
    } catch (err) {
      console.error(err);
      toast('Could not create a new room — check your connection');
    }
    els.liveSetupGenerate.disabled = false;
  });

  els.liveSetupSave.addEventListener('click', () => {
    const url = els.liveRoomInput.value.trim();
    if (!isValidDailyUrl(url)) {
      toast('Enter your full Daily.co room link, e.g. https://yoursubdomain.daily.co/yourroom');
      return;
    }
    localStorage.setItem(LIVE_ROOM_KEY, url);
    syncLiveRoomToAccount(url);
    closeLiveSetup();
    toast('Live View room saved');
    if (liveAutoStartAfterSetup) startLiveView();
    liveAutoStartAfterSetup = false;
  });

  function updateLiveUI() {
    els.liveToggle.classList.toggle('active', liveActive);
    els.liveToggle.textContent = liveActive ? '📡 End Live' : '📡 Go Live';
    els.liveBadge.classList.toggle('hidden', !liveActive);
    els.liveRecordBtn.classList.toggle('hidden', !liveActive);
  }

  function shareLiveLink(roomUrl) {
    if (navigator.share) {
      navigator.share({ title: 'Live property walkthrough', url: roomUrl }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(roomUrl)
        .then(() => toast('Link copied — send it to the homeowner'))
        .catch(() => toast('Link: ' + roomUrl));
    } else {
      toast('Link: ' + roomUrl);
    }
  }

  async function startLiveView() {
    if (!stream) { toast('Start the camera first'); return; }
    if (!window.Daily) { toast('Live view failed to load — check your connection and try again'); return; }
    let roomUrl = getLiveRoomUrl();
    if (!roomUrl) {
      // First time this device has gone live: auto-create its own room, no setup needed.
      toast('Setting up your live room…');
      try {
        roomUrl = await provisionRoom();
        localStorage.setItem(LIVE_ROOM_KEY, roomUrl);
        syncLiveRoomToAccount(roomUrl);
      } catch (err) {
        console.error(err);
        toast('Could not auto-create a room — tap ⚙️ to set one up manually');
        openLiveSetup(true);
        return;
      }
    } else {
      // Room already existed locally (e.g. set up before this device's account ever
      // synced one) — push it to the account doc now so Watch Live can find it too.
      syncLiveRoomToAccount(roomUrl);
    }
    try {
      const track = stream.getVideoTracks()[0];
      // Mic is requested as its own getUserMedia stream (separate from the shared camera
      // track) since Daily needs a raw audio MediaStreamTrack, not the speech-recognition
      // API used for voice-naming. We own this track's lifecycle and must stop it ourselves.
      let micTrack = false;
      try {
        liveMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micTrack = liveMicStream.getAudioTracks()[0];
      } catch (micErr) {
        console.error(micErr);
        toast('Mic access denied — going live with video only');
        liveMicStream = null;
      }
      setupRecordingAudioGraph(micTrack || null); // ready to record the moment "Record" is tapped
      dailyCall = window.Daily.createCallObject({
        url: roomUrl,
        videoSource: track,
        audioSource: micTrack,
      });
      attachRemoteAudioHandlers(dailyCall); // lets the inspector hear the homeowner talk back
      attachPointerHandler(dailyCall); // shows the desk viewer's pointer dot, if they point at something
      await dailyCall.join();
      liveActive = true;
      updateLiveUI();
      shareLiveLink(roomUrl);
    } catch (err) {
      console.error(err);
      toast('Could not start live view — try again');
      if (dailyCall) { try { dailyCall.destroy(); } catch (e) {} dailyCall = null; }
      if (liveMicStream) { liveMicStream.getTracks().forEach((t) => t.stop()); liveMicStream = null; }
      clearRemoteAudio();
      teardownRecordingAudioGraph();
      liveActive = false;
      updateLiveUI();
    }
  }

  async function stopLiveView() {
    if (isRecording) await stopRecording(); // wait so the last chunk saves before we tear anything down
    if (dailyCall) {
      try { await dailyCall.leave(); } catch (e) {}
      try { dailyCall.destroy(); } catch (e) {}
      dailyCall = null;
    }
    if (liveMicStream) {
      liveMicStream.getTracks().forEach((t) => t.stop());
      liveMicStream = null;
    }
    clearRemoteAudio();
    teardownRecordingAudioGraph();
    els.livePointerDot.classList.add('hidden');
    liveActive = false;
    updateLiveUI();
  }

  els.liveToggle.addEventListener('click', () => {
    if (liveActive) stopLiveView(); else startLiveView();
  });

  /* ---------------- Watch Live (desk-side viewer) ---------------- */
  // The desk user has no camera of their own to broadcast — they want to watch/talk to
  // the field inspector instead, the moment that inspector taps "Go Live" on their phone.
  // Both devices are signed into the SAME account, and startLiveView()/syncLiveRoomToAccount()
  // (above) write that account's current room to Firestore users/{uid}.liveRoomUrl every
  // time the inspector goes live — so tapping "Watch Live" here just reads that same field
  // back and joins, with nobody ever typing or pasting a link. The manual-entry modal still
  // exists only as a fallback (e.g. watching a different account's room someone texted you).
  //
  // This joins via Daily's call-object API (the same one the inspector's Go Live uses)
  // rather than the prebuilt iframe embed used previously. That trade — losing Daily's
  // built-in call UI chrome in favor of these custom controls — is what gives this page
  // direct pixel/track access to the remote video, which both the pointer and capture
  // features below depend on (a cross-origin iframe would block both).
  async function joinWatchLive(url) {
    if (!isValidDailyUrl(url)) {
      toast('Enter the full Daily.co link the inspector shared, e.g. https://yoursubdomain.daily.co/theirroom');
      return;
    }
    if (!window.Daily) { toast('Live view failed to load — check your connection and try again'); return; }
    closeWatchLiveModal();
    els.watchLiveFrameWrap.classList.remove('hidden');
    els.watchLiveBadge.classList.remove('hidden');
    try {
      let micTrack = false;
      try {
        watchMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micTrack = watchMicStream.getAudioTracks()[0];
      } catch (micErr) {
        console.warn('Mic unavailable for Watch Live', micErr);
        watchMicStream = null;
      }
      watchCall = window.Daily.createCallObject({ url, videoSource: false, audioSource: micTrack });
      watchCall.on('track-started', (ev) => {
        if (!ev.participant || ev.participant.local || !ev.track) return;
        if (ev.track.kind === 'video') {
          els.watchLiveVideo.srcObject = new MediaStream([ev.track]);
        } else if (ev.track.kind === 'audio') {
          els.watchLiveAudio.srcObject = new MediaStream([ev.track]);
          els.watchLiveAudio.play().catch(() => {});
        }
      });
      await watchCall.join();
      watchMuted = false;
      els.watchLiveMute.classList.remove('muted');
    } catch (err) {
      console.error(err);
      toast('Could not connect to the live inspection — try again');
      leaveWatchLive();
    }
  }

  function openWatchLiveFallback(prefillUrl) {
    els.watchLiveInput.value = prefillUrl || '';
    els.watchLiveModal.classList.add('active');
  }

  function closeWatchLiveModal() {
    els.watchLiveModal.classList.remove('active');
  }

  function leaveWatchLive() {
    if (watchCall) {
      try { watchCall.leave(); } catch (e) {}
      try { watchCall.destroy(); } catch (e) {}
      watchCall = null;
    }
    if (watchMicStream) {
      watchMicStream.getTracks().forEach((t) => t.stop());
      watchMicStream = null;
    }
    els.watchLiveVideo.srcObject = null;
    els.watchLiveAudio.srcObject = null;
    els.watchLiveFrameWrap.classList.add('hidden');
    els.watchLiveBadge.classList.add('hidden');
    watchMuted = false;
    els.watchLiveMute.classList.remove('muted');
    lastPointerVisible = false;
  }

  async function startWatchLive() {
    if (!currentFirebaseUser) { toast('Sign in first'); return; }
    if (!window.fbGetUserDoc) { openWatchLiveFallback(); return; }
    els.watchLiveBtn.disabled = true;
    try {
      // Always read fresh from Firestore (not the cached currentUserDoc) so a room the
      // inspector just went live with seconds ago is picked up immediately.
      const userDoc = await window.fbGetUserDoc(currentFirebaseUser.uid);
      const roomUrl = userDoc && (userDoc.liveRoomUrl || '').trim();
      if (roomUrl && isValidDailyUrl(roomUrl)) {
        joinWatchLive(roomUrl);
      } else {
        toast('No active inspection found — have the field inspector tap "Go Live" first');
        openWatchLiveFallback(roomUrl || '');
      }
    } catch (err) {
      console.error(err);
      toast('Could not check for a live inspection — try again');
      openWatchLiveFallback();
    }
    els.watchLiveBtn.disabled = false;
  }

  els.watchLiveBtn.addEventListener('click', startWatchLive);
  els.watchLiveCancel.addEventListener('click', closeWatchLiveModal);
  els.watchLiveJoin.addEventListener('click', () => joinWatchLive(els.watchLiveInput.value.trim()));
  els.watchLiveClose.addEventListener('click', leaveWatchLive);
  els.watchLiveLeave.addEventListener('click', leaveWatchLive);

  els.watchLiveMute.addEventListener('click', () => {
    if (!watchCall) return;
    watchMuted = !watchMuted;
    try { watchCall.setLocalAudio(!watchMuted); } catch (e) {}
    els.watchLiveMute.classList.toggle('muted', watchMuted);
  });

  // Remote pointer — lets the desk viewer point at something on the inspector's screen
  // by moving their mouse over the video. Coordinates are normalized (0-1) against the
  // video's own intrinsic frame size, accounting for the letterboxing object-fit:contain
  // adds, then sent over Daily's low-latency app-message data channel (no extra server
  // needed — it rides the same WebRTC connection as the video/audio).
  function pointerToNormalized(e, videoEl) {
    const rect = videoEl.getBoundingClientRect();
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh || !rect.width || !rect.height) return null;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dispW = vw * scale, dispH = vh * scale;
    const offsetX = (rect.width - dispW) / 2, offsetY = (rect.height - dispH) / 2;
    const x = e.clientX - rect.left - offsetX;
    const y = e.clientY - rect.top - offsetY;
    if (x < 0 || y < 0 || x > dispW || y > dispH) return null; // over a letterbox bar, not the video itself
    return { nx: x / dispW, ny: y / dispH };
  }

  function sendPointer(nx, ny, visible) {
    if (!watchCall) return;
    try {
      watchCall.sendAppMessage({ type: 'pointer', nx, ny, visible }, '*');
      console.log('[watch-live] sent pointer', { nx, ny, visible });
    } catch (e) { console.error('[watch-live] sendAppMessage failed', e); }
  }

  els.watchLivePointerZone.addEventListener('mousemove', (e) => {
    const p = pointerToNormalized(e, els.watchLiveVideo);
    if (p) { lastPointerNx = p.nx; lastPointerNy = p.ny; lastPointerVisible = true; }
    const now = Date.now();
    if (now - lastPointerSendAt < 40) return; // cap at ~25 updates/sec — plenty smooth, low bandwidth
    lastPointerSendAt = now;
    if (p) sendPointer(p.nx, p.ny, true);
  });
  els.watchLivePointerZone.addEventListener('mouseleave', () => {
    lastPointerVisible = false;
    sendPointer(0, 0, false);
  });

  // Draws the same arrow shown on the inspector's screen onto a canvas, in canvas-pixel
  // coordinates — used by Capture below to bake the pointer into the saved photo. Path
  // matches the #live-pointer-dot SVG (24x24 viewBox) so both pointers look identical.
  function drawPointerArrow(ctx, x, y, size) {
    const s = size / 24;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(2, 2);
    ctx.lineTo(2, 18);
    ctx.lineTo(6.5, 14.5);
    ctx.lineTo(9.5, 21);
    ctx.lineTo(12.5, 19.5);
    ctx.lineTo(9.5, 13);
    ctx.lineTo(16, 13);
    ctx.closePath();
    ctx.fillStyle = '#ff3b30';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.3;
    ctx.lineJoin = 'round';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Capture — grabs whatever frame is currently showing from the inspector's live feed
  // and runs it through the exact same naming/tagging/save pipeline as a normal shutter
  // press, so a moment caught during a live walkthrough ends up in the gallery (and
  // eventually the report) like any other photo. If the desk viewer is currently pointing
  // at something, that arrow is baked into the saved image at the same spot.
  els.watchLiveCapture.addEventListener('click', () => {
    const video = els.watchLiveVideo;
    if (!video.videoWidth) { toast('No live video to capture yet'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (lastPointerVisible) {
      const size = Math.max(canvas.width, canvas.height) * 0.045;
      drawPointerArrow(ctx, lastPointerNx * canvas.width, lastPointerNy * canvas.height, size);
    }
    canvas.toBlob((blob) => {
      if (blob) openNaming(blob, false);
    }, 'image/jpeg', 0.92);
  });

  // Cheap downsampled pixel fingerprint of the current video frame. A real camera
  // sensor never produces two bit-identical frames (noise alone guarantees that), so
  // an exact match against the previous capture means the feed is frozen — the field
  // report this guards against: shutter kept prompting for new names while silently
  // resaving the same photo.
  function frameSignature(video) {
    const c = document.createElement('canvas');
    c.width = 12; c.height = 12;
    const cx = c.getContext('2d');
    cx.drawImage(video, 0, 0, 12, 12);
    return cx.getImageData(0, 0, 12, 12).data.join(',');
  }

  function capturePhoto() {
    const video = els.video;
    const signature = frameSignature(video);
    if (lastFrameSignature !== null && signature === lastFrameSignature) {
      toast('Camera feed looks frozen — restarting camera. Tap the shutter again.');
      startCamera();
      return;
    }
    lastFrameSignature = signature;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Captured here (at the moment of the shutter press) rather than read again later —
    // by the time naming finishes the heading may have drifted, and this is the value
    // that actually corresponds to the photo just taken.
    const headingAtCapture = (compassOn && compassHeading != null) ? compassHeading : null;
    if (headingAtCapture != null) {
      stampCompass(ctx, canvas.width, canvas.height, headingAtCapture);
    }
    canvas.toBlob((blob) => {
      if (blob) openNaming(blob, false, undefined, undefined, headingAtCapture);
    }, 'image/jpeg', 0.92);
  }

  els.shutter.addEventListener('click', capturePhoto);

  /* ---------------- Library import ---------------- */
  // Normalizes any picked file (HEIC, PNG, large camera-roll JPEG, etc.) into a
  // consistent JPEG, capped at a sane resolution so storage/export stay predictable.
  function normalizeImportedFile(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const MAX_DIM = 2400;
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          resolve(blob || file);
        }, 'image/jpeg', 0.92);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  if (els.pickPhoto) els.pickPhoto.addEventListener('click', () => {
    els.photoPicker.value = '';
    els.photoPicker.click();
  });
  if (els.desktopImportMenuBtn) {
    els.desktopImportMenuBtn.addEventListener('click', () => {
      // Close dropdown first
      const dd = document.getElementById('gallery-menu-dropdown');
      const mb = document.getElementById('gallery-menu-btn');
      if (dd) dd.classList.remove('open');
      if (mb) mb.classList.remove('menu-open');
      els.photoPicker.value = '';
      els.photoPicker.click();
    });
  }

  els.photoPicker.addEventListener('change', async () => {
    const files = Array.from(els.photoPicker.files || []);
    if (!files.length) return;
    const images = files.filter((f) => f.type.startsWith('image/'));
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
    // "Choose Photos or PDFs from Desktop" picks both types in one dialog — PDFs go
    // straight to the same attach-as-document pipeline used elsewhere, photos go
    // through the normal naming/import queue.
    if (pdfs.length) await attachPdfFiles(pdfs);
    if (images.length) {
      importQueue = images;
      importTotal = images.length;
      processNextImport();
    }
  });

  // Opens the naming overlay with the raw picked file immediately (no decode/resize first).
  // Speech recognition on iOS only starts reliably right inside a user gesture — any await
  // (like normalizing a large library photo) before recognition.start() can cause Safari to
  // silently drop the mic. The file is normalized to JPEG later, at Save time.
  function processNextImport() {
    if (!importQueue.length) {
      importTotal = 0;
      return;
    }
    const num = importTotal - importQueue.length + 1;
    const file = importQueue.shift();
    openNaming(file, true, num, importTotal);
  }

  /* ---------------- Speech recognition ---------------- */
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  const speechSupported = !!SpeechRecognitionImpl;

  function buildRecognizer() {
    const r = new SpeechRecognitionImpl();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let finalText = '';
      let interimText = '';
      for (let i = 0; i < e.results.length; i++) {
        const piece = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += piece + ' ';
        else interimText += piece;
      }
      currentTranscript = (finalText + interimText).trim();
      renderTranscript();
      resetSilenceTimer();
    };
    r.onerror = (e) => {
      console.warn('speech error', e.error);
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      els.micLabel.textContent = 'Mic unavailable — type the name instead';
      els.micDot.style.background = '#666';
    };
    r.onend = () => {
      recognizing = false;
      recognitionTornDown = true;
      // if recognition stops on its own (silence timeout from OS) and we have text, treat as done
    };
    return r;
  }

  function renderTranscript() {
    if (currentTranscript) {
      els.transcriptText.textContent = currentTranscript;
      els.transcriptText.classList.remove('placeholder');
      els.btnSave.disabled = false;
    } else {
      els.transcriptText.textContent = 'Speak now…';
      els.transcriptText.classList.add('placeholder');
      els.btnSave.disabled = true;
    }
  }

  function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    if (!currentTranscript) return;
    silenceTimer = setTimeout(() => {
      stopListening();
      els.micLabel.textContent = 'Got it — tap Save, or Edit to fix';
    }, SILENCE_AUTOSAVE_MS);
  }

  function startListening() {
    currentTranscript = '';
    renderTranscript();
    els.micLabel.textContent = 'Listening… say the photo name';
    els.micDot.style.background = '#ff3b30';
    if (!speechSupported) {
      els.micLabel.textContent = 'Speech recognition not supported — tap Edit to type a name';
      els.micDot.style.background = '#666';
      return;
    }

    const begin = () => {
      try {
        recognition = buildRecognizer();
        recognition.start();
        recognizing = true;
        recognitionTornDown = false;
      } catch (err) {
        console.error(err);
        // Starting too soon after the previous session — retry once, shortly.
        setTimeout(begin, 300);
      }
    };

    if (recognitionTornDown) {
      begin();
    } else {
      // The previous recognition session is still releasing the mic on iOS — starting
      // a new one now gets silently dropped (or throws). Wait for its real teardown
      // (onend), with a bounded fallback so this can never hang indefinitely.
      let started = false;
      const tryBegin = () => {
        if (started) return;
        started = true;
        clearInterval(poll);
        clearTimeout(fallback);
        begin();
      };
      const poll = setInterval(() => { if (recognitionTornDown) tryBegin(); }, 50);
      const fallback = setTimeout(tryBegin, 400);
    }
  }

  function stopListening() {
    clearTimeout(silenceTimer);
    if (recognition && recognizing) {
      // abort() tears down the mic faster than stop() — we don't need trailing
      // results here, and a quicker release means less wait before the next photo.
      try { recognition.abort(); } catch (e) {}
    }
    recognizing = false;
  }

  /* ---------------- Naming overlay flow ---------------- */
  // Resets the category/sub-location tag row to its default ("Other"/uncategorized)
  // state and hides the direction sub-row. Called every time a fresh photo enters
  // naming so one photo's tags never carry over onto the next. Note there is no
  // free-text sub-location field — the voice/typed name already captures the
  // room or area, so a second text field would just duplicate that.
  function resetTagRow() {
    pendingCategory = '';
    pendingSubLocation = '';
    els.namingCatRow.querySelectorAll('.cat-btn').forEach((b) => b.classList.toggle('active', b.dataset.cat === ''));
    els.namingSublocDir.classList.add('hidden');
    els.namingSublocDir.querySelectorAll('.dir-btn').forEach((b) => { b.classList.remove('active', 'suggested'); });
    els.namingRoomRow.classList.add('hidden');
    els.namingRoomSelect.value = '';
    els.namingRoomSelect.classList.remove('selected');
  }

  // Applies the auto-suggested elevation (a small "•" marker, not a forced selection)
  // to the direction row once the property's front-facing direction is known — the
  // inspector still has to tap a direction for it to actually be saved.
  function applySuggestedDirection() {
    if (pendingCategory !== 'exterior') return;
    const suggestion = suggestElevation(pendingHeading, pendingFrontFacing);
    els.namingSublocDir.querySelectorAll('.dir-btn').forEach((b) => {
      b.classList.toggle('suggested', !!suggestion && b.dataset.dir === suggestion && pendingSubLocation !== b.dataset.dir);
    });
  }

  function openNaming(blob, imported = false, num, total, heading = null) {
    pendingBlob = blob;
    pendingOriginalBlob = null;
    pendingImported = imported;
    pendingHeading = heading;
    resetTagRow();
    els.namingImg.src = URL.createObjectURL(blob);
    els.namingOverlay.classList.remove('hidden');
    els.btnRetry.textContent = imported ? 'Skip' : 'Retake';
    if (imported) {
      els.importProgress.textContent = `Importing photo ${num} of ${total}`;
      els.importProgress.style.display = 'block';
    } else {
      els.importProgress.style.display = 'none';
    }
    // Fetched fresh each time rather than cached, so a frontFacing direction set
    // mid-inspection (or switching properties) takes effect on the very next photo.
    getCurrentFolderFrontFacing().then((dir) => {
      pendingFrontFacing = dir;
      applySuggestedDirection();
    });
    if (silentMode) {
      // Silent mode: mic stays off, pre-assign an auto-name so Save is enabled immediately
      silentPhotoCount++;
      currentTranscript = 'Photo ' + silentPhotoCount;
      renderTranscript();
      els.micDot.style.background = '#555';
      els.micDot.style.animation = 'none';
      els.micLabel.textContent = '🔇 Silent mode — select category then tap Save';
      els.btnSave.disabled = false;
    } else {
      startListening();
    }
  }

  function closeNaming() {
    stopListening();
    els.namingOverlay.classList.add('hidden');
    if (els.namingImg.src) URL.revokeObjectURL(els.namingImg.src);
    pendingBlob = null;
    pendingOriginalBlob = null;
    currentTranscript = '';
    pendingImported = false;
    pendingCategory = '';
    pendingSubLocation = '';
    pendingHeading = null;
    els.importProgress.style.display = 'none';
    els.btnRetry.textContent = 'Retake';
    // Restore mic-dot animation for next open (may have been suppressed by silent mode)
    els.micDot.style.animation = '';
  }

  els.namingCatRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-btn');
    if (!btn) return;
    pendingCategory = btn.dataset.cat;
    pendingSubLocation = '';
    els.namingCatRow.querySelectorAll('.cat-btn').forEach((b) => b.classList.toggle('active', b === btn));
    els.namingSublocDir.querySelectorAll('.dir-btn').forEach((b) => b.classList.remove('active', 'suggested'));
    els.namingRoomSelect.value = '';
    els.namingRoomSelect.classList.remove('selected');

    if (pendingCategory === 'exterior') {
      els.namingSublocDir.classList.remove('hidden');
      els.namingRoomRow.classList.add('hidden');
      applySuggestedDirection();
    } else if (pendingCategory === 'interior') {
      els.namingSublocDir.classList.add('hidden');
      els.namingRoomRow.classList.remove('hidden');
    } else {
      els.namingSublocDir.classList.add('hidden');
      els.namingRoomRow.classList.add('hidden');
    }
  });

  els.namingSublocDir.addEventListener('click', (e) => {
    const btn = e.target.closest('.dir-btn');
    if (!btn) return;
    pendingSubLocation = btn.dataset.dir;
    els.namingSublocDir.querySelectorAll('.dir-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.classList.remove('suggested');
    });
  });

  // Interior rooms come from a fixed list (rather than free text) so report sections
  // group consistently regardless of how each inspector phrases a room name out loud.
  els.namingRoomSelect.addEventListener('change', () => {
    pendingSubLocation = els.namingRoomSelect.value;
    els.namingRoomSelect.classList.toggle('selected', !!els.namingRoomSelect.value);
  });

  els.btnRetry.addEventListener('click', () => {
    const wasImported = pendingImported;
    closeNaming();
    if (wasImported) processNextImport();
  });

  els.btnEdit.addEventListener('click', () => {
    stopListening();
    const speakAgain = confirm('Tap OK to say the name again, or Cancel to type it.');
    if (speakAgain) {
      startListening();
      return;
    }
    const typed = prompt('Photo name:', currentTranscript || '');
    if (typed !== null) {
      currentTranscript = typed.trim();
      renderTranscript();
    }
  });

  els.btnSave.addEventListener('click', () => {
    if (!pendingBlob || !currentTranscript) return;
    stopListening();
    const wasImported = pendingImported;
    const blobToProcess = pendingBlob;
    const originalBlobToSave = pendingOriginalBlob;
    const transcript = currentTranscript;
    const category = pendingCategory;
    const subLocation = pendingSubLocation;
    const heading = pendingHeading;
    const building = currentBuilding; // persists across photos — not reset in closeNaming()
    closeNaming();
    // Advance to the next queued photo (and start its mic) synchronously, in the same
    // gesture as this click. Any await here — even a fast one — can push recognition.start()
    // past iOS Safari's user-activation window and silently kill the mic for that photo.
    if (wasImported) processNextImport();
    // Normalizing + saving happens in the background so it never blocks the queue advance.
    (async () => {
      const blobToSave = wasImported ? await normalizeImportedFile(blobToProcess) : blobToProcess;
      const now = Date.now();
      const record = {
        id: 'p_' + now + '_' + Math.random().toString(36).slice(2, 7),
        name: transcript,
        blob: blobToSave,
        createdAt: now,
        order: now,
        folderId: currentFolderId,
      };
      if (originalBlobToSave) record.originalBlob = originalBlobToSave;
      if (category) record.category = category;
      if (subLocation) record.subLocation = subLocation;
      if (heading != null) record.heading = heading;
      if (building) record.building = building;
      await dbAdd(record);
      toast('Saved: ' + transcript, 'success');
      await refreshGallery();
    })();
  });

  /* ---------------- Tabs ---------------- */
  // Camera gating: a brand-new install has no project yet, and shooting straight into
  // an unnamed/default folder is how photos end up needing to be re-sorted later. So on
  // phones, the live feed (and its getUserMedia prompt) is withheld until a real project
  // has been created or selected at least once — see #project-gate in index.html.
  function hasRealProject() {
    return localStorage.getItem(HAS_CREATED_PROJECT_KEY) === '1';
  }
  function showProjectGate() {
    els.projectGate.classList.remove('hidden');
    els.cameraStartPrompt.classList.add('hidden');
  }
  function hideProjectGate() {
    els.projectGate.classList.add('hidden');
  }
  function showCameraStartPrompt() {
    els.cameraStartName.textContent = currentFolderName || 'Project';
    hideProjectGate();
    // Reflect current auto-sync state on the interval buttons
    const asLabel = document.getElementById('camera-start-autosave-label');
    if (asLabel) {
      asLabel.textContent = autoSyncEnabled
        ? `☁️ Auto-Save: ON (${autoSyncIntervalMin} min)`
        : '☁️ Auto-Save every:';
    }
    document.querySelectorAll('.camera-autosave-interval').forEach((btn) => {
      const min = parseInt(btn.dataset.min, 10);
      btn.classList.toggle('selected', autoSyncEnabled && min === autoSyncIntervalMin);
      btn.disabled = autoSyncEnabled;
    });
    els.cameraStartPrompt.classList.remove('hidden');
  }
  function hideCameraStartPrompt() {
    els.cameraStartPrompt.classList.add('hidden');
  }
  // Called right after a project is created or selected. Surfaces the "Start Camera? /
  // Add Customer Info Now" prompt instead of silently engaging the camera as a side effect
  // of a project-picker tap. Used to bail out early if a feed was already running (nothing
  // to confirm) — but that's no longer true now this prompt also offers "Add Customer Info
  // Now": e.g. Save & Start Camera starts the feed for project A, then switching straight to
  // a newly-created project B via Add & Switch should still get its own chance to add
  // customer info, even though the camera (still showing project A's feed) never stopped.
  function offerCameraStartIfNeeded() {
    if (isDesktopDevice()) {
      // Desktop has no camera feed to offer — previously this just bailed out entirely,
      // so desktop users never got a chance to add customer/claim info right after
      // creating a project. Show the lightweight desktop equivalent (PDF option only)
      // instead of taking over the dashboard view the mobile prompt would.
      els.dskPromptName.textContent = currentFolderName || 'Project';
      els.dskPromptModal.classList.add('active');
      return;
    }
    // The "Current Project" pill and "Add & Switch" live in the tab bar, reachable from the
    // Gallery tab too — previously this bailed out whenever the camera tab wasn't already
    // showing, so creating/switching a project from Gallery silently skipped this prompt
    // entirely (including the "Add Customer Info Now" PDF option). Switch the view itself
    // to the camera tab first — without calling showCamera()/startCamera(), which would
    // launch the live feed immediately and bypass this prompt altogether.
    if (els.cameraView.classList.contains('hidden')) {
      els.cameraView.classList.remove('hidden');
      els.galleryView.classList.remove('active');
      els.tabCamera.classList.add('active');
      els.tabGallery.classList.remove('active');
      hideProjectGate();
    }
    showCameraStartPrompt();
  }
  els.projectGateCreate.addEventListener('click', () => openFoldersModal(true));
  els.projectGateSelect.addEventListener('click', () => openFoldersModal(false));
  els.cameraStartGo.addEventListener('click', () => {
    hideCameraStartPrompt();
    // If a feed is already running (this prompt can now appear after switching to a new
    // project while an earlier project's camera was left on — see offerCameraStartIfNeeded),
    // there's nothing to start; restarting would just stop and re-request the same feed.
    if (stream) return;
    startCamera();
  });
  els.cameraStartPdf.addEventListener('click', () => {
    hideCameraStartPrompt();
    openPdfOptionsForProject();
  });
  document.querySelectorAll('.camera-autosave-interval').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const min = parseInt(btn.dataset.min, 10);
      // Get an interactive Drive token using this tap gesture (required on iOS)
      const token = await getDriveAccessToken({ interactive: true });
      if (!token) {
        toast('Auto-Save requires Google Drive sign-in');
        return;
      }
      autoSyncIntervalMin = min;
      localStorage.setItem(AUTO_SYNC_INTERVAL_KEY, String(min));
      autoSyncEnabled = true;
      localStorage.setItem(AUTO_SYNC_KEY, '1');
      applyAutoSyncToggle();
      startAutoSync(); // token is cached — will succeed immediately
      // Update the group in place — no need to close the prompt
      const asLabel = document.getElementById('camera-start-autosave-label');
      if (asLabel) asLabel.textContent = `☁️ Auto-Save: ON (${min} min)`;
      document.querySelectorAll('.camera-autosave-interval').forEach((b) => {
        b.classList.toggle('selected', parseInt(b.dataset.min, 10) === min);
        b.disabled = true;
      });
      toast(`☁️ Auto-Save ON — photos upload every ${min} min while you work`);
    });
  });
  els.dskPromptSkip.addEventListener('click', () => {
    els.dskPromptModal.classList.remove('active');
  });
  els.dskPromptPdf.addEventListener('click', () => {
    els.dskPromptModal.classList.remove('active');
    openPdfOptionsForProject();
  });

  function showCamera() {
    els.cameraView.classList.remove('hidden');
    els.galleryView.classList.remove('active');
    els.tabCamera.classList.add('active');
    els.tabGallery.classList.remove('active');
    document.body.classList.add('camera-active');
    // Desktop users open this tab almost exclusively to use the "Choose from Library"
    // icon, not to shoot a photo — don't trigger a webcam permission prompt for that.
    // The .desktop-cam class (CSS) hides the shutter/flip-cam/compass controls (meaningless
    // without a live feed), swaps in a calm placeholder instead of a blank black canvas,
    // and makes the library-import button a labeled, prominent pill instead of a small icon.
    const desktop = isDesktopDevice();
    els.cameraView.classList.toggle('desktop-cam', desktop);
    if (desktop) { refreshDesktopSummary(); return; }

    if (!hasRealProject()) {
      showProjectGate();
      return; // no getUserMedia call at all while gated
    }
    hideProjectGate();
    hideCameraStartPrompt();
    startCamera();
  }

  function showGallery() {
    els.cameraView.classList.add('hidden');
    els.galleryView.classList.add('active');
    els.tabGallery.classList.add('active');
    els.tabCamera.classList.remove('active');
    document.body.classList.remove('camera-active');
    stopCamera();
    refreshGallery();
  }

  els.tabCamera.addEventListener('click', showCamera);
  els.tabGallery.addEventListener('click', showGallery);

  /* ---------------- Desktop dashboard (camera-tab placeholder) ---------------- */
  // Desktop has no camera feed of its own, so the "Camera tab" placeholder is repurposed
  // as a lightweight dashboard: which property is active, how many photos exist per
  // report section (so a missing section is visible before generating a report), and
  // recent imports — all without leaving this tab. Only does work when .desktop-cam
  // is active; cheap no-op otherwise.
  async function refreshDesktopSummary() {
    if (!els.cameraView.classList.contains('desktop-cam')) return;
    const records = await getFolderPhotos(currentFolderId);
    // Match the top pill's behavior: don't surface the default bootstrap folder's
    // generic name anywhere until the user has actually created a real project.
    const hasCreated = localStorage.getItem(HAS_CREATED_PROJECT_KEY) === '1';
    if (els.dskSummaryCard) els.dskSummaryCard.classList.toggle('hidden', !hasCreated);
    els.dskSummaryName.textContent = currentFolderName || 'Select project';
    els.dskSummaryCount.textContent = records.length === 1 ? '1 photo' : `${records.length} photos`;

    els.dskCatBreakdown.innerHTML = '';
    if (records.length) {
      const counts = { exterior: 0, roof: 0, interior: 0, other: 0 };
      for (const r of records) counts[bucketKey(r)]++;
      for (const c of CATEGORY_ORDER) {
        const pill = document.createElement('span');
        const empty = counts[c.key] === 0;
        pill.className = 'dsk-cat-pill' + (empty ? ' dsk-cat-empty' : '');
        pill.textContent = `${c.title.replace(' Photos', '').replace(' Elevations', '').replace(' Rooms', '')}: ${counts[c.key]}`;
        els.dskCatBreakdown.appendChild(pill);
      }
    }

    els.dskRecentStrip.innerHTML = '';
    const recent = records.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);
    if (!recent.length) {
      const empty = document.createElement('div');
      empty.id = 'dsk-recent-empty';
      empty.textContent = 'No photos imported yet';
      els.dskRecentStrip.appendChild(empty);
    } else {
      for (const rec of recent) {
        if (rec.kind === 'video') {
          const div = document.createElement('div');
          div.className = 'dsk-recent-icon';
          div.title = rec.name;
          div.textContent = '🎥';
          els.dskRecentStrip.appendChild(div);
        } else if (rec.kind === 'pdf') {
          const div = document.createElement('div');
          div.className = 'dsk-recent-icon';
          div.title = rec.name;
          div.textContent = '📄';
          els.dskRecentStrip.appendChild(div);
        } else {
          const img = document.createElement('img');
          img.src = URL.createObjectURL(rec.blob);
          img.title = rec.name;
          img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: false });
          els.dskRecentStrip.appendChild(img);
        }
      }
    }
  }

  els.dskActionPdf.addEventListener('click', async () => {
    const records = await getFolderPhotos(currentFolderId);
    if (!records.length) { toast('No photos in this project yet'); return; }
    openPdfOptions(records);
  });
  els.dskActionAttach.addEventListener('click', () => els.attachDocBtn.click());
  els.dskActionSwitch.addEventListener('click', () => openFoldersModal());

  // Drag-and-drop import — desktop users dragging files straight from their file
  // manager is faster than clicking through a file picker. Reuses the exact same
  // importQueue/processNextImport pipeline as "Choose from Library" so naming,
  // normalization, and folder-scoping all behave identically either way.
  els.dskDropzone.addEventListener('click', () => { els.photoPicker.value = ''; els.photoPicker.click(); });
  els.dskDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dskDropzone.classList.add('drag-over');
  });
  els.dskDropzone.addEventListener('dragleave', () => {
    els.dskDropzone.classList.remove('drag-over');
  });
  els.dskDropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.dskDropzone.classList.remove('drag-over');
    const dropped = Array.from(e.dataTransfer?.files || []);
    const images = dropped.filter((f) => f.type.startsWith('image/'));
    const pdfs = dropped.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
    if (!images.length && !pdfs.length) { toast('Drop photos or PDF files to import them'); return; }
    if (pdfs.length) await attachPdfFiles(pdfs);
    if (images.length) {
      importQueue = images;
      importTotal = images.length;
      processNextImport();
    }
  });

  /* ---------------- Gallery ---------------- */
  function sanitizeFilename(name) {
    return name.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 80) || 'photo';
  }

  // PDF gallery thumbnails — renders each record's first page via pdf.js (already loaded
  // from the CDN for the report-preview feature) and caches the result by record id, so a
  // PDF only ever gets rendered once no matter how many times refreshGallery() re-runs
  // (every photo add/delete/reorder/select-toggle calls it). `null` is cached too — a
  // distinct sentinel from "not yet attempted" (Map.get returns undefined for that) — so a
  // PDF that fails to parse isn't retried on every single refresh.
  const pdfThumbCache = new Map(); // rec.id -> data URL string, or null if rendering failed
  async function renderPdfThumb(rec) {
    if (!window.pdfjsLib) return null;
    try {
      const buf = await rec.blob.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      const page = await pdf.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      // Grid thumbnails are small — render at a fixed target width rather than full
      // resolution, both for speed and so the cached data URL stays small in memory.
      const scale = 240 / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch (err) {
      console.error('PDF thumbnail render failed for', rec.id, err);
      return null;
    }
  }

  async function refreshGallery() {
    const allRecords = await getFolderPhotos(currentFolderId);
    // Reorder drags re-derive each photo's order from DOM position, so filtering
    // the grid mid-reorder would scramble the hidden, non-matching photos. Search
    // is ignored (and disabled) while reorder mode is active.
    let records = (!reorderMode && gallerySearchQuery)
      ? allRecords.filter((r) => r.name.toLowerCase().includes(gallerySearchQuery))
      : allRecords;
    if (!reorderMode && activeBuildingFilter) {
      records = records.filter((r) => r.building === activeBuildingFilter);
    }
    els.grid.innerHTML = '';
    if (!allRecords.length) {
      els.emptyState.textContent = 'No photos yet. Take some on the Camera tab.';
      els.emptyState.style.display = 'block';
    } else if (!records.length) {
      els.emptyState.textContent = 'No photos match your search.';
      els.emptyState.style.display = 'block';
    } else {
      els.emptyState.style.display = 'none';
    }
    if (els.photoCount) {
      const n = records.length;
      els.photoCount.textContent = n === 1 ? '1 photo' : `${n} photos`;
      els.photoCount.classList.toggle('visible', n > 0);
    }
    els.exportBtn.disabled = allRecords.length === 0;
    els.pdfAllBtn.disabled = allRecords.length === 0;
    els.backupBtn.disabled = allRecords.length === 0;
    els.driveSyncBtn.disabled = allRecords.length === 0;
    els.grid.classList.toggle('select-mode', selectMode);
    els.grid.classList.toggle('reorder-mode', reorderMode);
    els.gallerySearch.disabled = reorderMode;
    galleryIds = records.map((r) => r.id);

    // Drop any selected ids whose photo no longer exists (e.g. deleted elsewhere).
    const liveIds = new Set(galleryIds);
    for (const id of Array.from(selectedIds)) if (!liveIds.has(id)) selectedIds.delete(id);
    updateBulkBar();

    for (const rec of records) {
      const div = document.createElement('div');
      div.className = 'thumb' + (selectedIds.has(rec.id) ? ' selected' : '') + (rec.kind === 'video' ? ' video-thumb' : '');
      div.dataset.id = rec.id;
      let img;
      if (rec.kind === 'video') {
        img = document.createElement('div');
        img.className = 'video-thumb-icon';
        img.textContent = '🎥';
      } else if (rec.kind === 'pdf') {
        img = document.createElement('div');
        img.className = 'pdf-thumb-icon';
        img.textContent = '📄';
        // Swap the plain icon for a rendered first-page thumbnail once it's ready. Cached
        // by id (see renderPdfThumb above) so this only actually renders once per PDF —
        // every later refreshGallery() call for the same record hits the cache synchronously.
        if (pdfThumbCache.has(rec.id)) {
          const cached = pdfThumbCache.get(rec.id);
          if (cached) {
            img.style.backgroundImage = `url("${cached}")`;
            img.classList.add('pdf-thumb-rendered');
            img.textContent = '';
          }
        } else {
          renderPdfThumb(rec).then((dataUrl) => {
            pdfThumbCache.set(rec.id, dataUrl);
            // The grid may have already re-rendered (or this item been deleted) by the time
            // the render finishes — only touch this specific tile if it's still live.
            if (!dataUrl || !img.isConnected) return;
            img.style.backgroundImage = `url("${dataUrl}")`;
            img.classList.add('pdf-thumb-rendered');
            img.textContent = '';
          });
        }
      } else {
        img = document.createElement('img');
        img.src = URL.createObjectURL(rec.blob);
        img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: false });
      }
      const label = document.createElement('div');
      label.className = 'label';
      // Category chip — only shown for explicitly categorized photos (not 'other'/unset)
      const catKey = rec.category && ['exterior', 'roof', 'interior'].includes(rec.category) ? rec.category : null;
      if (catKey) {
        const chip = document.createElement('span');
        chip.className = 'cat-chip ' + catKey;
        const catAbbr = catKey === 'exterior' ? 'EXT' : catKey === 'roof' ? 'ROOF' : 'INT';
        chip.textContent = rec.subLocation ? `${catAbbr} · ${rec.subLocation}` : catAbbr;
        label.appendChild(chip);
      }
      const nameText = document.createTextNode(rec.building ? `[${rec.building}] ${rec.name}` : rec.name);
      label.appendChild(nameText);
      const selectDot = document.createElement('div');
      selectDot.className = 'select-dot';
      const dragHandle = document.createElement('div');
      dragHandle.className = 'drag-handle';
      dragHandle.textContent = '⠿';
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm('Delete "' + rec.name + '"?')) {
          await dbDelete(rec.id);
          refreshGallery();
        }
      });
      div.addEventListener('click', () => {
        if (reorderMode) {
          // Tap to mark/unmark for group move
          if (reorderSelected.has(rec.id)) {
            reorderSelected.delete(rec.id);
            div.classList.remove('move-selected');
          } else {
            reorderSelected.add(rec.id);
            div.classList.add('move-selected');
          }
          return;
        }
        if (selectMode) {
          toggleSelected(rec.id, div);
        } else {
          openDetail(rec);
        }
      });
      div.appendChild(img);
      div.appendChild(label);
      const cloudBadge = document.createElement('div');
      cloudBadge.className = rec.driveSynced ? 'cloud-badge' : 'cloud-badge unsaved';
      cloudBadge.title = rec.driveSynced ? 'Saved to Cloud' : 'Not Saved to Cloud';
      cloudBadge.textContent = '☁';
      div.appendChild(cloudBadge);
      if (rec.backedUp) {
        const badge = document.createElement('div');
        badge.className = 'backup-badge';
        badge.title = 'Saved to Photos library';
        badge.textContent = '✓';
        div.appendChild(badge);
      }
      div.appendChild(selectDot);
      div.appendChild(dragHandle);
      div.appendChild(del);
      els.grid.appendChild(div);
    }

    if (reorderMode) attachReorderHandlers();
    refreshDesktopSummary();
  }

  function toggleSelected(id, div) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      div.classList.remove('selected');
    } else {
      selectedIds.add(id);
      div.classList.add('selected');
    }
    updateBulkBar();
  }

  /* ---------------- Drag-and-drop reorder ---------------- */
  // Swaps two sibling DOM nodes in place — used instead of "insert at index" so a
  // drag only ever displaces the one thumbnail currently under the finger.
  function swapThumbs(a, b) {
    const parent = a.parentNode;
    const aNext = a.nextElementSibling;
    const bNext = b.nextElementSibling;
    if (aNext === b) {
      parent.insertBefore(b, a);
    } else if (bNext === a) {
      parent.insertBefore(a, b);
    } else {
      parent.insertBefore(b, aNext);
      parent.insertBefore(a, bNext);
    }
  }

  async function persistReorder() {
    const ids = Array.from(els.grid.querySelectorAll('.thumb')).map((t) => t.dataset.id);
    const records = await dbGetAll();
    const byId = new Map(records.map((r) => [r.id, r]));
    const base = Date.now();
    const updated = [];
    ids.forEach((id, i) => {
      const rec = byId.get(id);
      if (!rec) return;
      rec.order = base + i;
      updated.push(rec);
    });
    if (updated.length) await dbPutAll(updated);
    galleryIds = ids;
  }

  // Pointer-based drag (not the HTML5 Drag and Drop API, which iOS Safari doesn't
  // support for touch). Each thumb tracks its own pointer session; on move, it
  // re-measures its untransformed position every frame so dragging stays glued
  // to the finger even as swaps shift the grid underneath it.
  function attachReorderHandlers() {
    const thumbs = Array.from(els.grid.querySelectorAll('.thumb'));
    thumbs.forEach((thumb) => {
      let dragging = false;
      let pointerId = null;
      let grabX = 0, grabY = 0;
      let lastClientX = 0, lastClientY = 0;
      let scrollRafId = null;

      // Auto-scroll the gallery when the dragged thumb is near the top or bottom edge.
      // Runs in a rAF loop so it fires even when the pointer isn't moving.
      function autoScrollStep() {
        if (!dragging) return;
        const scrollEl = els.galleryView;
        const sr = scrollEl.getBoundingClientRect();
        const ZONE = 80;   // px from edge that triggers scroll
        const distTop = lastClientY - sr.top;
        const distBot = sr.bottom - lastClientY;
        if (distTop >= 0 && distTop < ZONE) {
          scrollEl.scrollTop -= Math.ceil(12 * (1 - distTop / ZONE));
        } else if (distBot >= 0 && distBot < ZONE) {
          scrollEl.scrollTop += Math.ceil(12 * (1 - distBot / ZONE));
        }
        scrollRafId = requestAnimationFrame(autoScrollStep);
      }

      function onMove(e) {
        if (!dragging || e.pointerId !== pointerId) return;
        e.preventDefault();
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        thumb.style.transform = 'none';
        let rect = thumb.getBoundingClientRect();

        const prevVis = thumb.style.visibility;
        thumb.style.visibility = 'hidden';
        const target = document.elementFromPoint(e.clientX, e.clientY);
        thumb.style.visibility = prevVis;

        const overThumb = target && target.closest('.thumb');
        if (overThumb && overThumb !== thumb && overThumb.parentNode === els.grid) {
          swapThumbs(thumb, overThumb);
          rect = thumb.getBoundingClientRect();
        }

        const dx = e.clientX - grabX - rect.left;
        const dy = e.clientY - grabY - rect.top;
        thumb.style.transform = `translate(${dx}px, ${dy}px)`;
      }

      function onUp(e) {
        if (!dragging || e.pointerId !== pointerId) return;
        dragging = false;
        cancelAnimationFrame(scrollRafId);
        scrollRafId = null;
        thumb.classList.remove('dragging');
        thumb.style.transform = '';
        thumb.style.zIndex = '';
        els.grid.style.touchAction = '';
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);

        // Group move: if this thumb was marked, insert all other marked thumbs
        // immediately after it, then clear the group selection.
        if (reorderSelected.has(thumb.dataset.id) && reorderSelected.size > 1) {
          const others = Array.from(els.grid.querySelectorAll('.thumb'))
            .filter((t) => reorderSelected.has(t.dataset.id) && t !== thumb);
          let insertRef = thumb.nextElementSibling;
          others.forEach((t) => {
            t.classList.remove('move-selected');
            els.grid.insertBefore(t, insertRef); // null = append
          });
          thumb.classList.remove('move-selected');
          reorderSelected.clear();
        }

        persistReorder().catch((err) => console.error('reorder save failed', err));
      }

      thumb.addEventListener('pointerdown', (e) => {
        if (!reorderMode || e.target.closest('.del')) return;
        dragging = true;
        pointerId = e.pointerId;
        const rect = thumb.getBoundingClientRect();
        grabX = e.clientX - rect.left;
        grabY = e.clientY - rect.top;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        thumb.classList.add('dragging');
        thumb.style.zIndex = '20';
        els.grid.style.touchAction = 'none'; // lock scroll only while a drag is in progress
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        scrollRafId = requestAnimationFrame(autoScrollStep);
        e.preventDefault();
      });
    });
  }

  async function updateBulkBar() {
    const n = selectedIds.size;
    els.bulkCount.textContent = n + ' selected';
    els.bulkDelete.disabled = n === 0;
    els.bulkPdf.disabled = n === 0;
    els.bulkDownload.disabled = n === 0;
    els.bulkShare.disabled = n === 0;
    els.bulkCategorize.disabled = n === 0; // works on any number of selected photos, unlike rename
    els.bulkMoveBuilding.disabled = n === 0; // same — moving any number of photos at once is fine
    els.bulkMoveProject.disabled = n === 0; // same — moving any number of photos at once is fine
    els.bulkRename.disabled = n !== 1; // rename targets one item, so require exactly one selection

    // Markup/crop only make sense for a single selected photo — and not for a video
    // recording, since those tools assume an image blob and would error on one.
    let singleIsPhoto = false;
    if (n === 1) {
      const [id] = selectedIds;
      const records = await dbGetAll();
      const rec = records.find((r) => r.id === id);
      singleIsPhoto = !!rec && rec.kind !== 'video';
      els.bulkRemoveMarkup.disabled = !rec || !rec.originalBlob;
    } else {
      els.bulkRemoveMarkup.disabled = true;
    }
    els.bulkMarkup.disabled = !singleIsPhoto;
    els.bulkCrop.disabled = !singleIsPhoto;
    const allSelected = galleryIds.length > 0 && n === galleryIds.length;
    els.selectAllBtn.textContent = allSelected ? 'Deselect all' : 'Select all';
    // Flip building pills to green "assign-ready" mode whenever photos are selected
    els.buildingFilterBar.querySelectorAll('.bldg-pill').forEach((p) => {
      if (p.dataset.building === '') {
        // "All" pill — never assign-ready
        p.classList.toggle('active', n === 0 && !activeBuildingFilter);
      } else {
        p.classList.toggle('assign-ready', n > 0);
        p.classList.toggle('active', n === 0 && p.dataset.building === (activeBuildingFilter || ''));
      }
    });
  }

  els.bulkRename.addEventListener('click', async () => {
    if (selectedIds.size !== 1) return;
    const [id] = selectedIds;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === id);
    if (rec) openRename(rec);
  });

  els.bulkCategorize.addEventListener('click', () => {
    if (selectedIds.size === 0) return;
    openRecategorizeBulk([...selectedIds]);
  });

  els.bulkMoveBuilding.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    await openMoveBuildingBulk([...selectedIds]);
  });

  els.bulkMoveProject.addEventListener('click', () => {
    if (selectedIds.size === 0) return;
    openMoveProjectBulk([...selectedIds]);
  });

  els.bulkMarkup.addEventListener('click', async () => {
    if (selectedIds.size !== 1) return;
    const [id] = selectedIds;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    openAnnotator(rec.blob, async (newBlob) => {
      if (!rec.originalBlob) rec.originalBlob = rec.blob; // preserve pre-markup blob so it can be restored later
      rec.blob = newBlob;
      await dbAdd(rec);
      refreshGallery();
    });
  });

  els.bulkCrop.addEventListener('click', async () => {
    if (selectedIds.size !== 1) return;
    const [id] = selectedIds;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    openCropper(rec.blob, async (newBlob) => {
      if (!rec.originalBlob) rec.originalBlob = rec.blob; // preserve pre-crop blob so it can be restored later
      rec.blob = newBlob;
      await dbAdd(rec);
      refreshGallery();
    });
  });

  els.bulkRemoveMarkup.addEventListener('click', async () => {
    if (selectedIds.size !== 1) return;
    const [id] = selectedIds;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === id);
    if (!rec || !rec.originalBlob) return;
    if (!confirm('Restore the original, unedited photo?')) return;
    rec.blob = rec.originalBlob;
    delete rec.originalBlob;
    await dbAdd(rec);
    refreshGallery();
  });

  // Gallery action dropdown toggle
  (function() {
    const menuBtn = document.getElementById('gallery-menu-btn');
    const dropdown = document.getElementById('gallery-menu-dropdown');
    if (!menuBtn || !dropdown) return;
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.toggle('open');
      menuBtn.classList.toggle('menu-open', isOpen);
    });
    // Close when clicking a button inside the dropdown (except export sub-menu)
    dropdown.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn && btn.id !== 'export-btn') {
        dropdown.classList.remove('open');
        menuBtn.classList.remove('menu-open');
      }
    });
    // Close on outside click
    document.addEventListener('click', () => {
      dropdown.classList.remove('open');
      menuBtn.classList.remove('menu-open');
    });
  })();

  els.selectBtn.addEventListener('click', () => {
    selectMode = !selectMode;
    els.selectBtn.classList.toggle('active', selectMode);
    els.selectBtn.textContent = selectMode ? 'Cancel' : 'Select';
    els.bulkBar.classList.toggle('active', selectMode);
    if (!selectMode) selectedIds.clear();
    if (selectMode && reorderMode) {
      reorderMode = false;
      reorderSelected.clear();
      els.reorderBtn.classList.remove('active');
      els.reorderBtn.textContent = 'Rearrange Photos';
    }
    refreshGallery();
  });

  els.reorderBtn.addEventListener('click', () => {
    reorderMode = !reorderMode;
    els.reorderBtn.classList.toggle('active', reorderMode);
    els.reorderBtn.textContent = reorderMode ? 'Done' : 'Rearrange Photos';
    if (reorderMode && selectMode) {
      selectMode = false;
      selectedIds.clear();
      els.selectBtn.classList.remove('active');
      els.selectBtn.textContent = 'Select';
      els.bulkBar.classList.remove('active');
    }
    refreshGallery();
  });

  els.selectAllBtn.addEventListener('click', () => {
    const allSelected = galleryIds.length > 0 && selectedIds.size === galleryIds.length;
    if (allSelected) {
      selectedIds.clear();
    } else {
      selectedIds = new Set(galleryIds);
    }
    refreshGallery();
  });

  els.bulkDelete.addEventListener('click', async () => {
    const n = selectedIds.size;
    if (!n) return;
    if (!confirm(`Delete ${n} photo${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    for (const id of selectedIds) await dbDelete(id);
    selectedIds.clear();
    selectMode = false;
    els.selectBtn.classList.remove('active');
    els.selectBtn.textContent = 'Select';
    els.bulkBar.classList.remove('active');
    refreshGallery();
  });

  function openRename(rec) {
    renameTargetId = rec.id;
    els.renameInput.value = rec.name;
    els.renameModal.classList.add('active');
    setTimeout(() => els.renameInput.focus(), 50);
  }

  attachDictation(els.renameMic, els.renameInput);

  els.renameCancel.addEventListener('click', () => {
    els.renameModal.classList.remove('active');
    renameTargetId = null;
  });

  els.renameSave.addEventListener('click', async () => {
    if (!renameTargetId) return;
    const newName = els.renameInput.value.trim();
    if (!newName) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === renameTargetId);
    if (rec) {
      rec.name = newName;
      await dbAdd(rec);
      // Update the detail view's name header immediately if it's the photo currently open,
      // so the change is visibly confirmed before the user closes the detail view.
      if (detailRecordId === rec.id) {
        detailEls.name.textContent = rec.name;
      }
    }
    els.renameModal.classList.remove('active');
    selectedIds.delete(renameTargetId);
    renameTargetId = null;
    refreshGallery();
  });

  /* ---------------- Recategorize modal ----------------
     Lets photos that only ever got a voice name — and so landed in "Additional Photos"
     (bucketKey() === 'other') — be assigned a real report category after the fact, without
     redoing the capture/naming flow. Reuses the same category/sub-location shape used by the
     naming overlay (rec.category + rec.subLocation), just operating on existing record(s).
     recatTargetIds holds one ID for the single-photo detail-view flow, or several for the
     bulk gallery-select flow — the save handler below treats both the same way. */
  let recatTargetIds = [];
  let recatPendingCategory = '';
  let recatPendingSubLocation = '';
  let recatTitleEl = null; // lazily found — the <h3> inside #recat-card, used to show the selection count for bulk

  function recatSetRow(category, subLocation) {
    recatPendingCategory = category || '';
    recatPendingSubLocation = subLocation || '';
    els.recatCatRow.querySelectorAll('.recat-cat-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.cat === recatPendingCategory);
    });
    els.recatSublocDir.classList.toggle('hidden', recatPendingCategory !== 'exterior');
    els.recatRoomRow.classList.toggle('hidden', recatPendingCategory !== 'interior');
    els.recatSublocDir.querySelectorAll('.recat-dir-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.dir === recatPendingSubLocation);
    });
    els.recatRoomSelect.value = recatPendingCategory === 'interior' ? recatPendingSubLocation : '';
  }

  function recatSetTitle(text) {
    if (!recatTitleEl) recatTitleEl = els.recatModal.querySelector('#recat-card h3');
    if (recatTitleEl) recatTitleEl.textContent = text;
  }

  function openRecategorize(rec) {
    recatTargetIds = [rec.id];
    recatSetTitle('Categorize photo');
    recatSetRow(rec.category, rec.subLocation);
    els.recatModal.classList.add('active');
  }

  // Bulk path: selection can mix categories, so don't presume one — start from Other/blank
  // and let the user pick a single category/sub-location to apply to every selected photo.
  function openRecategorizeBulk(ids) {
    recatTargetIds = ids;
    recatSetTitle(`Categorize ${ids.length} photo${ids.length === 1 ? '' : 's'}`);
    recatSetRow('', '');
    els.recatModal.classList.add('active');
  }

  els.recatCatRow.querySelectorAll('.recat-cat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      recatPendingCategory = btn.dataset.cat;
      // Switching category clears any previously chosen direction/room — they don't carry
      // over between categories (e.g. a "Front" elevation tag means nothing for Interior).
      recatPendingSubLocation = '';
      els.recatCatRow.querySelectorAll('.recat-cat-btn').forEach((b) => b.classList.toggle('active', b === btn));
      els.recatSublocDir.classList.toggle('hidden', recatPendingCategory !== 'exterior');
      els.recatRoomRow.classList.toggle('hidden', recatPendingCategory !== 'interior');
      els.recatSublocDir.querySelectorAll('.recat-dir-btn').forEach((b) => b.classList.remove('active'));
      els.recatRoomSelect.value = '';
    });
  });

  els.recatSublocDir.querySelectorAll('.recat-dir-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      recatPendingSubLocation = btn.dataset.dir;
      els.recatSublocDir.querySelectorAll('.recat-dir-btn').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  els.recatRoomSelect.addEventListener('change', () => {
    recatPendingSubLocation = els.recatRoomSelect.value;
  });

  els.recatCancel.addEventListener('click', () => {
    els.recatModal.classList.remove('active');
    recatTargetIds = [];
  });

  els.recatSave.addEventListener('click', async () => {
    if (recatTargetIds.length === 0) return;
    try {
      const records = await dbGetAll();
      const targetSet = new Set(recatTargetIds);
      const matches = records.filter((r) => targetSet.has(r.id));
      for (const rec of matches) {
        rec.category = recatPendingCategory;
        rec.subLocation = recatPendingSubLocation;
        await dbAdd(rec);
      }
      els.recatModal.classList.remove('active');
      recatTargetIds = [];
      const catLabel = recatPendingCategory === 'exterior' ? 'Exterior'
        : recatPendingCategory === 'roof' ? 'Roof'
        : recatPendingCategory === 'interior' ? 'Interior' : 'Other';
      toast(`${matches.length} photo${matches.length === 1 ? '' : 's'} set to ${catLabel}`);
      selectedIds.clear();
      selectMode = false;
      els.selectBtn.classList.remove('active');
      els.selectBtn.textContent = 'Select';
      els.bulkBar.classList.remove('active');
      refreshGallery();
    } catch (err) {
      console.error('Category save failed:', err);
      toast('Save failed — please try again');
    }
  });

  /* ---------------- Move to Building modal ----------------
     Lets a photo accidentally tagged under the wrong building (or saved with no
     building at all) get reassigned after the fact — the corrective counterpart to
     the Recategorize modal above, but for rec.building instead of rec.category. Lists
     whatever buildings already exist for the current project (projectBuildings — see
     "Multi-building support" above); there's nothing new to create here, just
     existing names to move into, plus a "No Building" option to un-assign.
     moveBuildingTargetIds holds one ID (detail view) or several (bulk select),
     exactly like recatTargetIds does for categorize. */
  let moveBuildingTargetIds = [];
  let moveBuildingCurrentBuildings = []; // current rec.building values for the target photo(s)

  async function assignToBuilding(buildingName) {
    if (!moveBuildingTargetIds.length) return;
    const records = await dbGetAll();
    const targetSet = new Set(moveBuildingTargetIds);
    const matches = records.filter((r) => targetSet.has(r.id));
    for (const rec of matches) {
      if (buildingName) rec.building = buildingName; else delete rec.building;
      await dbAdd(rec);
    }
    closeMoveBuildingModal();
    toast(buildingName ? `Assigned to ${buildingName}` : 'Building removed');
    selectedIds.clear();
    selectMode = false;
    els.selectBtn.classList.remove('active');
    els.selectBtn.textContent = 'Select';
    els.bulkBar.classList.remove('active');
    refreshGallery();
  }

  function renderMoveBuildingList() {
    els.moveBuildingList.innerHTML = '';
    const isBulk = moveBuildingTargetIds.length > 1;
    const total = moveBuildingTargetIds.length;

    // Build a frequency map: how many of the target photos are currently in each building
    // '' key = unassigned. Used for both the "CURRENT" badge (single) and count badges (bulk).
    const currentCounts = {};
    moveBuildingCurrentBuildings.forEach((b) => {
      const key = b || '';
      currentCounts[key] = (currentCounts[key] || 0) + 1;
    });

    if (!projectBuildings.length) {
      const empty = document.createElement('div');
      empty.id = 'move-building-empty';
      empty.textContent = 'No buildings yet — add one using the field below.';
      els.moveBuildingList.appendChild(empty);
      return;
    }

    const options = ['', ...projectBuildings]; // '' = "No Building" / unassigned
    options.forEach((b) => {
      const count = currentCounts[b] || 0;
      const isCurrent = !isBulk && count > 0;

      const row = document.createElement('div');
      row.className = 'building-row' + (isCurrent ? ' current' : '');

      const name = document.createElement('div');
      name.className = 'building-row-name';
      name.textContent = b || 'No Building';
      row.appendChild(name);

      if (isCurrent) {
        // Single photo — mark its current building
        const tag = document.createElement('div');
        tag.className = 'building-row-tag';
        tag.textContent = 'CURRENT';
        row.appendChild(tag);
      } else if (isBulk && count > 0) {
        // Bulk — show how many of the selected photos are already here
        const tag = document.createElement('div');
        tag.className = 'building-row-tag';
        tag.textContent = count === total ? 'ALL HERE' : `${count} here`;
        row.appendChild(tag);
      }

      row.addEventListener('click', () => assignToBuilding(b));
      els.moveBuildingList.appendChild(row);
    });
  }

  function openMoveBuilding(rec) {
    moveBuildingTargetIds = [rec.id];
    moveBuildingCurrentBuildings = [rec.building || ''];
    els.moveBuildingTitle.textContent = 'Assign Building';
    els.moveBuildingNewInput.value = '';
    renderMoveBuildingList();
    els.moveBuildingModal.classList.add('active');
  }

  // Bulk path — fetch the current building for each selected record so the modal
  // can show which building(s) photos are already in before the user taps.
  async function openMoveBuildingBulk(ids) {
    moveBuildingTargetIds = ids;
    moveBuildingCurrentBuildings = [];
    els.moveBuildingTitle.textContent = `Assign Building — ${ids.length} photo${ids.length === 1 ? '' : 's'}`;
    els.moveBuildingNewInput.value = '';
    // Fetch current building values before rendering so the count badges are accurate
    const allRecords = await dbGetAll();
    const targetSet = new Set(ids);
    allRecords.filter((r) => targetSet.has(r.id)).forEach((r) => {
      moveBuildingCurrentBuildings.push(r.building || '');
    });
    renderMoveBuildingList();
    els.moveBuildingModal.classList.add('active');
  }

  function closeMoveBuildingModal() {
    els.moveBuildingModal.classList.remove('active');
    moveBuildingTargetIds = [];
    moveBuildingCurrentBuildings = [];
    els.moveBuildingNewInput.value = '';
  }

  els.moveBuildingCancel.addEventListener('click', closeMoveBuildingModal);

  els.moveBuildingNewAdd.addEventListener('click', async () => {
    const typed = els.moveBuildingNewInput.value.trim();
    if (!typed) { els.moveBuildingNewInput.focus(); return; }
    if (!projectBuildings.includes(typed)) {
      projectBuildings.push(typed);
      saveBuildingState(currentFolderId);
      renderBuildingFilterBar();
    }
    await assignToBuilding(typed);
  });

  els.moveBuildingNewInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.moveBuildingNewAdd.click();
  });

  attachDictation(els.moveBuildingNewMic, els.moveBuildingNewInput);

  /* ---------------- Move to Project modal ----------------
     Sibling of the Move to Building modal above, but for rec.folderId — corrects a photo
     filed under the wrong project entirely. Lists every OTHER project (excludes the
     current one, since moving "into" the project a photo is already in is a no-op).
     Moving projects also clears rec.building: buildings are names scoped to a single
     project's projectBuildings list, so a building tag from the old project would be
     meaningless (and possibly misleading) in the new one. moveProjectTargetIds mirrors
     moveBuildingTargetIds/recatTargetIds — one id from the detail view, several from a
     bulk gallery selection. */
  let moveProjectTargetIds = [];

  async function renderMoveProjectList() {
    els.moveProjectList.innerHTML = '';
    const allFolders = await dbGetAllFolders();
    const others = allFolders.filter((f) => f.id !== currentFolderId);
    if (!others.length) {
      const empty = document.createElement('div');
      empty.id = 'move-project-empty';
      empty.textContent = 'No other projects exist yet. Create one first from the Projects screen.';
      els.moveProjectList.appendChild(empty);
      return;
    }
    others.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'building-row';
      const name = document.createElement('div');
      name.className = 'building-row-name';
      name.textContent = f.name || 'Untitled Project';
      row.appendChild(name);
      row.addEventListener('click', async () => {
        if (!moveProjectTargetIds.length) return;
        const records = await dbGetAll();
        const targetSet = new Set(moveProjectTargetIds);
        const matches = records.filter((r) => targetSet.has(r.id));
        for (const rec of matches) {
          rec.folderId = f.id;
          delete rec.building; // building names are scoped to the old project — drop the stale tag
          await dbAdd(rec);
        }
        closeMoveProjectModal();
        toast(`Moved to ${f.name || 'project'}`);
        selectedIds.clear();
        if (detailRecordId && targetSet.has(detailRecordId)) closeDetail();
        refreshGallery();
      });
      els.moveProjectList.appendChild(row);
    });
  }

  function openMoveProject(rec) {
    moveProjectTargetIds = [rec.id];
    els.moveProjectTitle.textContent = 'Move to Project';
    renderMoveProjectList();
    els.moveProjectModal.classList.add('active');
  }

  function openMoveProjectBulk(ids) {
    moveProjectTargetIds = ids;
    els.moveProjectTitle.textContent = `Move ${ids.length} photo${ids.length === 1 ? '' : 's'} to Project`;
    renderMoveProjectList();
    els.moveProjectModal.classList.add('active');
  }

  function closeMoveProjectModal() {
    els.moveProjectModal.classList.remove('active');
    moveProjectTargetIds = [];
  }

  els.moveProjectCancel.addEventListener('click', closeMoveProjectModal);

  /* ---------------- Photo detail modal ---------------- */
  const detailEls = {
    modal: document.getElementById('detail-modal'),
    img: document.getElementById('detail-img'),
    video: document.getElementById('detail-video'),
    name: document.getElementById('detail-name'),
    close: document.getElementById('detail-close'),
    annotate: document.getElementById('detail-annotate'),
    crop: document.getElementById('detail-crop'),
    removeMarkup: document.getElementById('detail-remove-markup'),
    share: document.getElementById('detail-share'),
    rename: document.getElementById('detail-rename'),
    categorize: document.getElementById('detail-categorize'),
    moveBuilding: document.getElementById('detail-move-building'),
    moveProject: document.getElementById('detail-move-project'),
    del: document.getElementById('detail-delete'),
    pdfTile: document.getElementById('detail-pdf-tile'),
    pdfOpen: document.getElementById('detail-pdf-open'),
  };
  let detailRecordId = null;
  let detailPdfUrl = null; // tracked so it can be revoked when the modal closes/reopens

  async function openDetail(rec) {
    detailRecordId = rec.id;
    detailEls.name.textContent = rec.name;
    const isVideo = rec.kind === 'video';
    const isPdf = rec.kind === 'pdf';
    detailEls.img.classList.toggle('hidden', isVideo || isPdf);
    detailEls.video.classList.toggle('hidden', !isVideo);
    detailEls.pdfTile.classList.toggle('hidden', !isPdf);
    if (detailPdfUrl) { URL.revokeObjectURL(detailPdfUrl); detailPdfUrl = null; }
    if (isVideo) {
      detailEls.video.src = URL.createObjectURL(rec.blob);
      detailEls.video.load();
    } else if (isPdf) {
      detailPdfUrl = URL.createObjectURL(rec.blob);
    } else {
      detailEls.img.src = URL.createObjectURL(rec.blob);
    }
    // Mark up/crop/restore assume an image blob and would error on a video or PDF.
    detailEls.annotate.classList.toggle('hidden', isVideo || isPdf);
    detailEls.crop.classList.toggle('hidden', isVideo || isPdf);
    detailEls.removeMarkup.classList.toggle('hidden', isVideo || isPdf || !rec.originalBlob);
    detailEls.categorize.classList.toggle('hidden', isVideo || isPdf);
    detailEls.modal.classList.add('active');
  }

  // Opens the attached PDF in a new tab/window so the adjuster can review the actual
  // weather/measurement report — this doesn't render inside the app's image viewer.
  detailEls.pdfOpen.addEventListener('click', () => {
    if (detailPdfUrl) window.open(detailPdfUrl, '_blank');
  });

  function closeDetail() {
    detailEls.modal.classList.remove('active');
    // pause() first — removing the src (or revoking its URL) alone doesn't stop
    // playback in Safari; the already-decoded audio keeps playing in the background
    // until the element is explicitly paused. load() resets it to a clean state.
    if (detailEls.video.src) {
      detailEls.video.pause();
      URL.revokeObjectURL(detailEls.video.src);
      detailEls.video.removeAttribute('src');
      detailEls.video.load();
    }
    if (detailPdfUrl) { URL.revokeObjectURL(detailPdfUrl); detailPdfUrl = null; }
    detailRecordId = null;
  }

  detailEls.close.addEventListener('click', closeDetail);

  detailEls.del.addEventListener('click', async () => {
    if (!detailRecordId) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === detailRecordId);
    if (rec && confirm('Delete "' + rec.name + '"?')) {
      await dbDelete(rec.id);
      closeDetail();
      refreshGallery();
    }
  });

  detailEls.rename.addEventListener('click', async () => {
    if (!detailRecordId) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === detailRecordId);
    if (rec) openRename(rec);
  });

  detailEls.categorize.addEventListener('click', async () => {
    if (!detailRecordId) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === detailRecordId);
    if (rec) openRecategorize(rec);
  });

  detailEls.moveBuilding.addEventListener('click', async () => {
    if (!detailRecordId) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === detailRecordId);
    if (rec) openMoveBuilding(rec);
  });

  detailEls.moveProject.addEventListener('click', async () => {
    if (!detailRecordId) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === detailRecordId);
    if (rec) openMoveProject(rec);
  });

  // Sends this one photo or video straight out via the iOS share sheet — Messages
  // is one of the options there, so this is how a recording (or photo) gets texted.
  detailEls.share.addEventListener('click', async () => {
    if (!detailRecordId) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === detailRecordId);
    if (!rec) return;
    const isVideo = rec.kind === 'video';
    const isPdf = rec.kind === 'pdf';
    const mimeType = rec.blob.type || (isVideo ? 'video/mp4' : isPdf ? 'application/pdf' : 'image/jpeg');
    const ext = isVideo ? (mimeType.includes('mp4') ? 'mp4' : 'webm') : isPdf ? 'pdf' : 'jpg';
    const file = new File([rec.blob], `${sanitizeFilename(rec.name)}.${ext}`, { type: mimeType });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: rec.name });
      } catch (e) { /* user cancelled — nothing to do */ }
    } else {
      toast('Sharing files isn’t supported in this browser');
    }
  });

  detailEls.annotate.addEventListener('click', async () => {
    if (!detailRecordId) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === detailRecordId);
    if (!rec) return;
    openAnnotator(rec.blob, async (newBlob) => {
      if (!rec.originalBlob) rec.originalBlob = rec.blob; // preserve pre-markup blob so it can be restored later
      rec.blob = newBlob;
      await dbAdd(rec);
      detailEls.img.src = URL.createObjectURL(newBlob);
      detailEls.removeMarkup.classList.remove('hidden');
      refreshGallery();
    });
  });

  detailEls.crop.addEventListener('click', async () => {
    if (!detailRecordId) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === detailRecordId);
    if (!rec) return;
    openCropper(rec.blob, async (newBlob) => {
      if (!rec.originalBlob) rec.originalBlob = rec.blob; // preserve pre-crop blob so it can be restored later
      rec.blob = newBlob;
      await dbAdd(rec);
      detailEls.img.src = URL.createObjectURL(newBlob);
      detailEls.removeMarkup.classList.remove('hidden');
      refreshGallery();
    });
  });

  detailEls.removeMarkup.addEventListener('click', async () => {
    if (!detailRecordId) return;
    const records = await dbGetAll();
    const rec = records.find((r) => r.id === detailRecordId);
    if (!rec || !rec.originalBlob) return;
    if (!confirm('Restore the original, unedited photo?')) return;
    rec.blob = rec.originalBlob;
    delete rec.originalBlob;
    await dbAdd(rec);
    detailEls.img.src = URL.createObjectURL(rec.blob);
    detailEls.removeMarkup.classList.add('hidden');
    refreshGallery();
  });

  /* ---------------- Annotation engine ---------------- */
  const annEls = {
    overlay: document.getElementById('annotate-overlay'),
    canvas: document.getElementById('annotate-canvas'),
    cancel: document.getElementById('annotate-cancel'),
    save: document.getElementById('annotate-save'),
    tools: document.getElementById('annotate-tools'),
    colors: document.getElementById('annotate-colors'),
    undo: document.getElementById('annotate-undo'),
    clear: document.getElementById('annotate-clear'),
  };

  let annImage = null;     // source Image element
  let annShapes = [];      // committed shapes, normalized coords (0-1)
  let annCurrent = null;   // in-progress shape
  let annTool = 'pen';
  let annColor = '#ff3b30';
  let annDrawing = false;
  let annSaveCallback = null;
  const annCtx = annEls.canvas.getContext('2d');

  function annSetTool(tool) {
    annTool = tool;
    [...annEls.tools.querySelectorAll('button')].forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
  }

  function annSetColor(color) {
    annColor = color;
    [...annEls.colors.querySelectorAll('.color-swatch')].forEach((b) => {
      b.classList.toggle('active', b.dataset.color === color);
    });
  }

  annEls.tools.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tool]');
    if (btn) annSetTool(btn.dataset.tool);
  });

  annEls.colors.addEventListener('click', (e) => {
    const btn = e.target.closest('.color-swatch');
    if (btn) annSetColor(btn.dataset.color);
  });

  function annDrawShape(ctx, shape, w, h) {
    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.color;
    const lw = Math.max(2, w * 0.006);
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (shape.type === 'pen') {
      if (!shape.points.length) return;
      ctx.beginPath();
      shape.points.forEach((p, i) => {
        const px = p.x * w, py = p.y * h;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    } else if (shape.type === 'rect') {
      const x1 = shape.x1 * w, y1 = shape.y1 * h, x2 = shape.x2 * w, y2 = shape.y2 * h;
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (shape.type === 'circle') {
      const x1 = shape.x1 * w, y1 = shape.y1 * h, x2 = shape.x2 * w, y2 = shape.y2 * h;
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (shape.type === 'line') {
      const x1 = shape.x1 * w, y1 = shape.y1 * h, x2 = shape.x2 * w, y2 = shape.y2 * h;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (shape.type === 'arrow') {
      const x1 = shape.x1 * w, y1 = shape.y1 * h, x2 = shape.x2 * w, y2 = shape.y2 * h;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = Math.max(12, w * 0.025);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else if (shape.type === 'text') {
      const fontSize = Math.max(16, w * 0.035);
      ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
      const x = shape.x * w, y = shape.y * h;
      ctx.lineWidth = fontSize * 0.18;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(shape.text, x, y);
      ctx.fillStyle = shape.color;
      ctx.fillText(shape.text, x, y);
    }
  }

  function annRedraw() {
    const w = annEls.canvas.width, h = annEls.canvas.height;
    annCtx.clearRect(0, 0, w, h);
    if (annImage) annCtx.drawImage(annImage, 0, 0, w, h);
    annShapes.forEach((s) => annDrawShape(annCtx, s, w, h));
    if (annCurrent) annDrawShape(annCtx, annCurrent, w, h);
  }

  function annGetPos(e) {
    const rect = annEls.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  function annPointerDown(e) {
    e.preventDefault();
    const pos = annGetPos(e);
    if (annTool === 'text') {
      const typed = prompt('Text to add:');
      if (typed && typed.trim()) {
        annShapes.push({ type: 'text', color: annColor, x: pos.x, y: pos.y, text: typed.trim() });
        annRedraw();
      }
      return;
    }
    annDrawing = true;
    if (annTool === 'pen') {
      annCurrent = { type: 'pen', color: annColor, points: [pos] };
    } else {
      annCurrent = { type: annTool, color: annColor, x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
    }
  }

  function annPointerMove(e) {
    if (!annDrawing || !annCurrent) return;
    e.preventDefault();
    const pos = annGetPos(e);
    if (annCurrent.type === 'pen') {
      annCurrent.points.push(pos);
    } else {
      annCurrent.x2 = pos.x;
      annCurrent.y2 = pos.y;
    }
    annRedraw();
  }

  function annPointerUp() {
    if (!annDrawing) return;
    annDrawing = false;
    if (annCurrent) {
      annShapes.push(annCurrent);
      annCurrent = null;
    }
    annRedraw();
  }

  annEls.canvas.addEventListener('pointerdown', annPointerDown);
  annEls.canvas.addEventListener('pointermove', annPointerMove);
  annEls.canvas.addEventListener('pointerup', annPointerUp);
  annEls.canvas.addEventListener('pointercancel', annPointerUp);

  annEls.undo.addEventListener('click', () => {
    annShapes.pop();
    annRedraw();
  });

  annEls.clear.addEventListener('click', () => {
    if (annShapes.length && !confirm('Clear all markup on this photo?')) return;
    annShapes = [];
    annRedraw();
  });

  annEls.cancel.addEventListener('click', () => {
    annEls.overlay.classList.remove('active');
    annSaveCallback = null;
  });

  annEls.save.addEventListener('click', () => {
    if (!annImage) return;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = annImage.naturalWidth;
    outCanvas.height = annImage.naturalHeight;
    const outCtx = outCanvas.getContext('2d');
    outCtx.drawImage(annImage, 0, 0, outCanvas.width, outCanvas.height);
    annShapes.forEach((s) => annDrawShape(outCtx, s, outCanvas.width, outCanvas.height));
    outCanvas.toBlob((blob) => {
      annEls.overlay.classList.remove('active');
      if (blob && annSaveCallback) annSaveCallback(blob);
      annSaveCallback = null;
    }, 'image/jpeg', 0.92);
  });

  function annResizeCanvas() {
    if (!annImage) return;
    const wrap = document.getElementById('annotate-canvas-wrap');
    const maxW = wrap.clientWidth, maxH = wrap.clientHeight;
    const ratio = annImage.naturalWidth / annImage.naturalHeight;
    let w = maxW, h = maxW / ratio;
    if (h > maxH) { h = maxH; w = maxH * ratio; }
    annEls.canvas.width = Math.round(w);
    annEls.canvas.height = Math.round(h);
    annEls.canvas.style.width = Math.round(w) + 'px';
    annEls.canvas.style.height = Math.round(h) + 'px';
    annRedraw();
  }

  function openAnnotator(blob, onSave) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      annImage = img;
      annShapes = [];
      annCurrent = null;
      annSaveCallback = onSave;
      annSetTool('pen');
      annSetColor('#ff3b30');
      annEls.overlay.classList.add('active');
      annResizeCanvas();
    };
    img.src = url;
  }

  window.addEventListener('resize', annResizeCanvas);

  /* ---------------- Crop / zoom / resize engine ---------------- */
  const cropEls = {
    overlay: document.getElementById('crop-overlay'),
    wrap: document.getElementById('crop-canvas-wrap'),
    frame: document.getElementById('crop-frame'),
    img: document.getElementById('crop-img'),
    aspectRow: document.getElementById('crop-aspect-row'),
    cancel: document.getElementById('crop-cancel'),
    reset: document.getElementById('crop-reset'),
    save: document.getElementById('crop-save'),
  };

  let cropImage = null;        // the <img> element being cropped (also the visible DOM element)
  let cropSaveCallback = null;
  let cropAspect = 'orig';     // 'orig' | '1:1' | '4:3' | '16:9' | '9:16'
  let cropScale = 1;           // current zoom factor applied to natural image size
  let cropBaseScale = 1;       // the "cover the frame" scale at zoom reset
  let cropPanX = 0, cropPanY = 0; // image center offset from frame center, in CSS px

  function cropAspectRatioValue(ratio, naturalW, naturalH) {
    if (ratio === 'orig') return naturalW / naturalH;
    const [w, h] = ratio.split(':').map(Number);
    return w / h;
  }

  function cropApplyTransform() {
    cropEls.img.style.transform =
      `translate(-50%, -50%) translate(${cropPanX}px, ${cropPanY}px) scale(${cropScale})`;
  }

  function cropClampPan() {
    if (!cropImage) return;
    const frameW = cropEls.frame.clientWidth, frameH = cropEls.frame.clientHeight;
    const imgW = cropImage.naturalWidth * cropScale, imgH = cropImage.naturalHeight * cropScale;
    const maxPanX = Math.max(0, (imgW - frameW) / 2);
    const maxPanY = Math.max(0, (imgH - frameH) / 2);
    cropPanX = Math.min(maxPanX, Math.max(-maxPanX, cropPanX));
    cropPanY = Math.min(maxPanY, Math.max(-maxPanY, cropPanY));
  }

  function cropResetView() {
    cropScale = cropBaseScale;
    cropPanX = 0;
    cropPanY = 0;
    cropApplyTransform();
  }

  function cropLayoutFrame() {
    if (!cropImage) return;
    const maxW = Math.max(40, cropEls.wrap.clientWidth - 24);
    const maxH = Math.max(40, cropEls.wrap.clientHeight - 24);
    const ratio = cropAspectRatioValue(cropAspect, cropImage.naturalWidth, cropImage.naturalHeight);
    let w = maxW, h = maxW / ratio;
    if (h > maxH) { h = maxH; w = maxH * ratio; }
    cropEls.frame.style.width = Math.round(w) + 'px';
    cropEls.frame.style.height = Math.round(h) + 'px';
    cropBaseScale = Math.max(w / cropImage.naturalWidth, h / cropImage.naturalHeight);
    cropResetView();
  }

  cropEls.aspectRow.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ratio]');
    if (!btn) return;
    cropAspect = btn.dataset.ratio;
    [...cropEls.aspectRow.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
    cropLayoutFrame();
  });

  cropEls.reset.addEventListener('click', cropResetView);

  // Pinch-to-zoom + drag-to-pan using the Pointer Events API, tracking up to
  // two simultaneous pointers (matches the touch/mouse-unified pattern used
  // elsewhere in this app for drag-reorder and the markup canvas).
  const cropPointers = new Map();
  let cropPanStart = null;
  let cropPinchStartDist = 0;
  let cropPinchStartScale = 1;

  function cropDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  cropEls.frame.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cropEls.frame.setPointerCapture(e.pointerId);
    cropPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (cropPointers.size === 1) {
      cropPanStart = { x: e.clientX, y: e.clientY, panX: cropPanX, panY: cropPanY };
    } else if (cropPointers.size === 2) {
      const pts = [...cropPointers.values()];
      cropPinchStartDist = cropDist(pts[0], pts[1]);
      cropPinchStartScale = cropScale;
    }
  });

  cropEls.frame.addEventListener('pointermove', (e) => {
    if (!cropPointers.has(e.pointerId)) return;
    e.preventDefault();
    cropPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (cropPointers.size === 2) {
      const pts = [...cropPointers.values()];
      const dist = cropDist(pts[0], pts[1]);
      if (cropPinchStartDist > 0) {
        const minScale = cropBaseScale;
        const maxScale = cropBaseScale * 4;
        cropScale = Math.min(maxScale, Math.max(minScale, cropPinchStartScale * (dist / cropPinchStartDist)));
        cropClampPan();
        cropApplyTransform();
      }
    } else if (cropPointers.size === 1 && cropPanStart) {
      cropPanX = cropPanStart.panX + (e.clientX - cropPanStart.x);
      cropPanY = cropPanStart.panY + (e.clientY - cropPanStart.y);
      cropClampPan();
      cropApplyTransform();
    }
  });

  function cropOnPointerEnd(e) {
    cropPointers.delete(e.pointerId);
    if (cropPointers.size === 1) {
      const [pt] = [...cropPointers.values()];
      cropPanStart = { x: pt.x, y: pt.y, panX: cropPanX, panY: cropPanY };
    } else {
      cropPanStart = null;
    }
  }
  cropEls.frame.addEventListener('pointerup', cropOnPointerEnd);
  cropEls.frame.addEventListener('pointercancel', cropOnPointerEnd);

  cropEls.cancel.addEventListener('click', () => {
    cropEls.overlay.classList.remove('active');
    cropSaveCallback = null;
  });

  cropEls.save.addEventListener('click', () => {
    if (!cropImage) return;
    const frameW = cropEls.frame.clientWidth, frameH = cropEls.frame.clientHeight;
    const imgDisplayW = cropImage.naturalWidth * cropScale;
    const imgDisplayH = cropImage.naturalHeight * cropScale;
    const imgTopLeftXInFrame = frameW / 2 - imgDisplayW / 2 + cropPanX;
    const imgTopLeftYInFrame = frameH / 2 - imgDisplayH / 2 + cropPanY;
    let srcX = -imgTopLeftXInFrame / cropScale;
    let srcY = -imgTopLeftYInFrame / cropScale;
    let srcW = frameW / cropScale;
    let srcH = frameH / cropScale;
    // Defensive clamp against floating-point drift at the edges.
    srcW = Math.min(srcW, cropImage.naturalWidth);
    srcH = Math.min(srcH, cropImage.naturalHeight);
    srcX = Math.max(0, Math.min(cropImage.naturalWidth - srcW, srcX));
    srcY = Math.max(0, Math.min(cropImage.naturalHeight - srcH, srcY));

    const outCanvas = document.createElement('canvas');
    outCanvas.width = Math.max(1, Math.round(srcW));
    outCanvas.height = Math.max(1, Math.round(srcH));
    const outCtx = outCanvas.getContext('2d');
    outCtx.drawImage(cropImage, srcX, srcY, srcW, srcH, 0, 0, outCanvas.width, outCanvas.height);
    outCanvas.toBlob((blob) => {
      cropEls.overlay.classList.remove('active');
      if (blob && cropSaveCallback) cropSaveCallback(blob);
      cropSaveCallback = null;
    }, 'image/jpeg', 0.92);
  });

  function openCropper(blob, onSave) {
    const url = URL.createObjectURL(blob);
    cropSaveCallback = onSave;
    cropAspect = 'orig';
    [...cropEls.aspectRow.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b.dataset.ratio === 'orig'));
    cropEls.img.onload = () => {
      cropImage = cropEls.img;
      cropEls.overlay.classList.add('active');
      cropLayoutFrame();
    };
    cropEls.img.onerror = () => { toast('Could not open photo for cropping — try again'); };
    cropEls.img.src = url;
  }

  window.addEventListener('resize', () => {
    if (cropEls.overlay.classList.contains('active')) cropLayoutFrame();
  });

  /* ---------------- Annotate button inside naming flow ---------------- */
  const btnAnnotateNew = document.getElementById('btn-annotate-new');
  if (btnAnnotateNew) {
    btnAnnotateNew.addEventListener('click', () => {
      if (!pendingBlob) return;
      stopListening();
      openAnnotator(pendingBlob, (newBlob) => {
        if (!pendingOriginalBlob) pendingOriginalBlob = pendingBlob;
        pendingBlob = newBlob;
        if (els.namingImg.src) URL.revokeObjectURL(els.namingImg.src);
        els.namingImg.src = URL.createObjectURL(newBlob);
      });
    });
  }

  /* ---------------- Export ---------------- */
  // Resizes/recompresses a photo for export so a full inspection (150-300+ photos)
  // zips down small enough to email. Stored originals in IndexedDB are untouched.
  function resizeBlobForExport(blob, maxDim, quality) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((outBlob) => {
          URL.revokeObjectURL(url);
          resolve(outBlob || blob);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
      img.src = url;
    });
  }

  // navigator.share's file path is built for the iOS share sheet (AirDrop, Mail, Messages) —
  // this app's only real mobile target. It's deliberately NOT gated on touch capability:
  // navigator.maxTouchPoints/'ontouchstart' are unreliable signals on Windows (many laptop
  // trackpad drivers report touch support with no touchscreen present), which let desktop
  // Chrome/Edge take the share-sheet path anyway — Chromium then throws
  // "NotAllowedError: Permission denied" from navigator.share() once the zip/PDF build time
  // eats into the click's user-activation window. Checking for iOS/iPadOS specifically avoids
  // that false positive. iPadOS 13+ reports itself as "MacIntel" with multiple touch points,
  // hence the second clause.
  function isAppleMobile() {
    return /iP(hone|od|ad)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function canUseFileShareSheet(files) {
    return isAppleMobile() && !!(navigator.canShare && navigator.canShare({ files }));
  }

  // Export/Zip now offers a quality choice on click instead of being a separate
  // "Save Originals" button — folded in to save header space. fullQuality:false applies
  // the email-friendly resize (1600px/0.8 quality); fullQuality:true skips it and zips
  // rec.blob as-is (any crop/markup/rename the user already applied is preserved either way —
  // only the lossy resize step used for emailing is skipped in full-quality mode).
  async function runZipExport(fullQuality) {
    closeExportQualityMenu();
    const records = await getFolderPhotos(currentFolderId);
    if (!records.length) return;
    els.exportBtn.disabled = true;
    const origText = els.exportBtn.textContent;
    els.exportBtn.textContent = 'Zipping…';
    try {
      const zip = new JSZip();
      const usedNames = new Map();
      const MAX_DIM = 1600, QUALITY = 0.8;
      for (const rec of records) {
        let base = sanitizeFilename(rec.name);
        const count = usedNames.get(base) || 0;
        usedNames.set(base, count + 1);
        if (rec.kind === 'video') {
          const ext = rec.blob.type.includes('mp4') ? 'mp4' : 'webm';
          const filename = count === 0 ? `${base}.${ext}` : `${base}_${count + 1}.${ext}`;
          zip.file(filename, rec.blob); // recordings are included as-is, no resize/re-encode
        } else {
          const filename = count === 0 ? `${base}.jpg` : `${base}_${count + 1}.jpg`;
          const exportBlob = fullQuality ? rec.blob : await resizeBlobForExport(rec.blob, MAX_DIM, QUALITY);
          zip.file(filename, exportBlob);
        }
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const stamp = new Date().toISOString().slice(0, 10);
      const projectPart = currentFolderName ? sanitizeFilename(currentFolderName) : 'inspection-photos';
      const namePart = fullQuality ? `${projectPart}-originals` : projectPart;
      const zipFile = new File([content], `${namePart}-${stamp}.zip`, { type: 'application/zip' });

      if (canUseFileShareSheet([zipFile])) {
        await navigator.share({ files: [zipFile], title: fullQuality ? 'Inspection Photos (Originals)' : 'Inspection Photos' });
      } else {
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = zipFile.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (err) {
      console.error(err);
      toast('Export failed — try again');
    } finally {
      els.exportBtn.disabled = false;
      els.exportBtn.textContent = origText;
    }
  }

  function closeExportQualityMenu() {
    els.exportQualityMenu.classList.remove('active');
  }
  function toggleExportQualityMenu(e) {
    e.stopPropagation();
    els.exportQualityMenu.classList.toggle('active');
  }

  els.exportBtn.addEventListener('click', toggleExportQualityMenu);
  els.exportQualityStandardBtn.addEventListener('click', () => runZipExport(false));
  els.exportQualityFullBtn.addEventListener('click', () => runZipExport(true));
  document.addEventListener('click', (e) => {
    if (!els.exportQualityMenu.classList.contains('active')) return;
    if (e.target === els.exportBtn || els.exportQualityMenu.contains(e.target)) return;
    closeExportQualityMenu();
  });

  // "Attach PDF" lets the adjuster import weather reports, measurement reports, etc.
  // from the phone/computer's file picker. Each one is stored as a normal gallery
  // record (kind:'pdf') so it shows up alongside photos, sorts by import order via
  // the same `order` timestamp field, and gets appended to the photo report as an
  // Attachments section by buildPdfReport().
  // Saves one or more PDF files as attachments on the current project. Shared by the
  // "Attach Document" picker button and by dropping PDFs straight onto the camera
  // page's drag-and-drop zone.
  async function attachPdfFiles(files) {
    if (!files.length) return;
    for (const file of files) {
      const now = Date.now();
      const name = file.name.replace(/\.pdf$/i, '');
      const record = {
        id: 'p_' + now + '_' + Math.random().toString(36).slice(2, 7),
        name: name || 'Attachment',
        blob: file,
        kind: 'pdf',
        createdAt: now,
        order: now,
        folderId: currentFolderId,
      };
      await dbAdd(record);
    }
    toast(files.length === 1 ? 'PDF attached' : `${files.length} PDFs attached`);
    await refreshGallery();
  }

  els.attachDocBtn.addEventListener('click', () => {
    els.docPicker.click();
  });

  els.docPicker.addEventListener('change', async () => {
    const files = Array.from(els.docPicker.files || []);
    els.docPicker.value = '';
    await attachPdfFiles(files);
  });

  // "Backup" saves this folder's photos/videos into the phone's own Photos library —
  // a real backup that survives the app's cache/storage being cleared, since iOS
  // gives no API for a web app to write there silently. The share sheet (with "Save
  // Image(s)"/"Save Video") is the only path in; the user must tap Save once per
  // batch. Each successfully-shared record is flagged backedUp so the gallery shows
  // a checkmark and re-running Backup only offers the photos that still need it.
  els.backupBtn.addEventListener('click', async () => {
    const records = await getFolderPhotos(currentFolderId);
    if (!records.length) return;
    const pending = records.filter((r) => !r.backedUp);
    if (!pending.length) {
      alert(`All ${records.length} item${records.length === 1 ? '' : 's'} in this folder are already backed up to your Photos library.`);
      return;
    }
    if (!navigator.share || !navigator.canShare) {
      toast('Backup needs the iOS share sheet — not supported in this browser');
      return;
    }
    // No confirm()/alert() here before navigator.share() — iOS Safari clears the
    // click's "user activation" the instant a blocking native dialog (confirm/alert)
    // is shown, so share() silently fails afterward. A non-blocking toast is safe;
    // a blocking dialog is not. Go straight from the tap into the share sheet.
    toast(`Opening share sheet for ${pending.length} item${pending.length === 1 ? '' : 's'}…`);

    els.backupBtn.disabled = true;
    const origText = els.backupBtn.textContent;
    const BATCH = 10; // keeps each share-sheet payload small enough for iOS to handle reliably
    let savedCount = 0;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      els.backupBtn.textContent = `Saving ${Math.min(i + BATCH, pending.length)}/${pending.length}…`;
      const usedNames = new Map();
      const files = batch.map((rec) => {
        const isVideo = rec.kind === 'video';
        const mimeType = rec.blob.type || (isVideo ? 'video/mp4' : 'image/jpeg');
        const ext = isVideo ? (mimeType.includes('mp4') ? 'mp4' : 'webm') : 'jpg';
        const base = sanitizeFilename(rec.name);
        const count = usedNames.get(base) || 0;
        usedNames.set(base, count + 1);
        const filename = count === 0 ? `${base}.${ext}` : `${base}_${count + 1}.${ext}`;
        return new File([rec.blob], filename, { type: mimeType });
      });
      if (!navigator.canShare({ files })) {
        toast('Sharing files isn’t supported in this browser');
        break;
      }
      try {
        await navigator.share({ files, title: batch.length === 1 ? batch[0].name : `${batch.length} items` });
        batch.forEach((rec) => { rec.backedUp = true; });
        await dbPutAll(batch);
        savedCount += batch.length;
      } catch (e) {
        break; // user cancelled the share sheet — stop here rather than pushing more batches at them
      }
    }
    els.backupBtn.disabled = false;
    els.backupBtn.textContent = origText;
    refreshGallery();

    if (savedCount === pending.length) {
      alert(`Backed up ${savedCount} item${savedCount === 1 ? '' : 's'} to your Photos library.`);
    } else if (savedCount > 0) {
      alert(`Backed up ${savedCount} of ${pending.length}. ${pending.length - savedCount} still need backing up — tap Backup again.`);
    } else {
      toast('Backup cancelled — nothing was saved');
    }
  });

  /* ---------------- PDF photo report ---------------- */
  // Loads a blob into an <img> and returns it together with its natural dimensions,
  // needed to lay the image out on a PDF page without distortion.
  function loadImageEl(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => resolve({ img, url, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
      img.src = url;
    });
  }

  // Re-encodes a photo to a capped-size JPEG data URL so the PDF stays a reasonable
  // size even for 150+ photos — mirrors the export-time resize logic above.
  function toJpegDataUrl(img, width, height, maxDim, quality) {
    let w = width, h = height;
    if (w > maxDim || h > maxDim) {
      const scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL('image/jpeg', quality), width: w, height: h };
  }

  // Center-crops (object-fit: cover) a photo to exactly match a target box's aspect
  // ratio, instead of letterboxing it inside the box. Mixed portrait/landscape photos
  // previously rendered at different visible sizes on the same page (each one scaled
  // independently to "fit" its box); cropping to the box's own aspect ratio means every
  // photo on a multi-photo page comes out the same width and height on the printed page.
  function toCoverFitJpegDataUrl(img, srcW, srcH, boxW, boxH, maxDim, quality) {
    const boxAspect = boxW / boxH;
    const srcAspect = srcW / srcH;
    let cropW, cropH, cropX, cropY;
    if (srcAspect > boxAspect) {
      cropH = srcH;
      cropW = srcH * boxAspect;
      cropX = (srcW - cropW) / 2;
      cropY = 0;
    } else {
      cropW = srcW;
      cropH = srcW / boxAspect;
      cropX = 0;
      cropY = (srcH - cropH) / 2;
    }
    let outW = cropW, outH = cropH;
    if (outW > maxDim || outH > maxDim) {
      const scale = maxDim / Math.max(outW, outH);
      outW = Math.round(outW * scale);
      outH = Math.round(outH * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(outW));
    canvas.height = Math.max(1, Math.round(outH));
    canvas.getContext('2d').drawImage(img, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  }

  // Page layouts available from the "Photos per page" option, as [cols, rows].
  const PDF_LAYOUTS = { 1: [1, 1], 2: [1, 2], 4: [2, 2], 6: [2, 3] };

  // Report sections, in the order they should appear — this is the "walkthrough"
  // structure: outside-in, top-to-bottom. Untagged/legacy photos fall into 'other'
  // and render last under "Additional Photos" so old reports without any tagging
  // still get every photo, just without section grouping (see showDividers below).
  const CATEGORY_ORDER = [
    { key: 'exterior', title: 'Exterior Elevations' },
    { key: 'roof', title: 'Roof' },
    { key: 'interior', title: 'Interior Rooms' },
    { key: 'other', title: 'Additional Photos' },
  ];

  function bucketKey(rec) {
    const k = rec.category;
    return CATEGORY_ORDER.some((c) => c.key === k) ? k : 'other';
  }

  const DIRECTION_PRIORITY = { Front: 0, Right: 1, Rear: 2, Left: 3 };

  // Within a section, exterior photos sort Front→Right→Rear→Left (the order a reader
  // would naturally walk the building); everything else sorts alphabetically by name;
  // untitled sub-locations fall back to capture order.
  function subLocationSortKey(rec) {
    const loc = (rec.subLocation || '').trim();
    const dirMatch = Object.keys(DIRECTION_PRIORITY).find((d) => loc === d || loc.startsWith(d + ' '));
    if (dirMatch) return [0, DIRECTION_PRIORITY[dirMatch], loc];
    if (loc) return [1, 0, loc.toLowerCase()];
    return [2, 0, ''];
  }

  function groupByCategory(records) {
    const buckets = new Map(CATEGORY_ORDER.map((c) => [c.key, []]));
    records.forEach((rec) => buckets.get(bucketKey(rec)).push(rec));
    buckets.forEach((arr) => arr.sort((a, b) => {
      const ka = subLocationSortKey(a), kb = subLocationSortKey(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      if (ka[2] !== kb[2]) return ka[2] < kb[2] ? -1 : 1;
      return (a.order ?? a.createdAt) - (b.order ?? b.createdAt);
    }));
    return CATEGORY_ORDER
      .map((c) => ({ key: c.key, title: c.title, records: buckets.get(c.key) }))
      .filter((s) => s.records.length);
  }

  // Multi-building claims (e.g. main house + detached garage on one customer's claim)
  // get an extra outer grouping layer, building before category, so the report reads
  // as "walk Building A top-to-bottom, then Building B" instead of interleaving
  // exterior/roof/interior photos from different structures. Untagged reports (the
  // common case — single structure) are completely unaffected: groupByCategory() runs
  // exactly as before with no building layer at all.
  function groupIntoSections(records) {
    if (!records.some((r) => r.building)) return groupByCategory(records);
    const order = [];
    records.forEach((r) => {
      const b = r.building || 'Unassigned';
      if (!order.includes(b)) order.push(b);
    });
    let sections = [];
    order.forEach((b) => {
      const subset = records.filter((r) => (r.building || 'Unassigned') === b);
      const catSections = groupByCategory(subset).map((s) => ({
        key: b + '::' + s.key,
        title: `${b} — ${s.title}`,
        records: s.records,
      }));
      sections = sections.concat(catSections);
    });
    return sections;
  }

  // Same idea as loadImageEl, but for the cover-page logo, which is already a data URL
  // (read from a <input type=file>) rather than a stored Blob.
  function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ img, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('logo failed to load'));
      img.src = dataUrl;
    });
  }

  // jsPDF's addImage is reliable with JPEG/PNG data URLs but not every source format a
  // user might pick for a logo (BMP, GIF, WEBP, etc.). Re-drawing through a canvas and
  // re-encoding as PNG normalizes any browser-decodable image into something addImage
  // can always place, and keeps transparency (unlike re-encoding to JPEG).
  function toPngDataUrl(img, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  }

  // Combines the address parts into a single line for the cover page / header — skips
  // parts the user left blank instead of leaving stray commas.
  function formatPropertyAddress(opts) {
    const { propertyAddress, propertyCity, propertyState, propertyZip } = opts;
    const cityStateZip = [propertyCity, [propertyState, propertyZip].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    return [propertyAddress, cityStateZip].filter(Boolean).join(', ');
  }

  // Same idea, for the company's own address — but kept as two separate lines
  // (street, then city/state/zip) since that's how it renders on the cover page.
  function formatCityStateZip(city, state, zip) {
    return [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }

  // Single brand accent used throughout the report (top bars, section titles, panel
  // borders) so it reads as one designed document rather than a stack of plain pages.
  const PDF_ACCENT = [27, 58, 94];      // navy
  const PDF_ACCENT_SOFT = [232, 237, 244]; // light tint of the accent, for panels/badges

  // Thin colored bar across the very top of a page — the one repeating visual element
  // that ties the cover, dividers, index, and photo pages together as a single report.
  function drawAccentBar(doc, pageW) {
    doc.setFillColor(...PDF_ACCENT);
    doc.rect(0, 0, pageW, 5, 'F');
  }

  // Plain "generated on <date>" + "Page X of Y" footer, repeated on every page (cover
  // included) — gives the report a consistent, dated chain of custody without relying
  // on whoever reads it to trust an undated stack of photos.
  function drawFooter(doc, margin, pageW, pageH, pageNum, totalPages, generatedOn) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(140, 140, 140);
    doc.setDrawColor(225, 225, 225);
    doc.line(margin, pageH - margin + 10, pageW - margin, pageH - margin + 10);
    doc.text(`Generated ${generatedOn}`, margin, pageH - margin + 22);
    doc.text(`Page ${pageNum} of ${totalPages}`, pageW - margin, pageH - margin + 22, { align: 'right' });
  }

  // Cover page: logo/company identity, report title, and the claim-identifying fields
  // (property, policy holder, claim #, inspector) laid out once up front — so the report
  // doesn't depend on a reader flipping through photo pages to confirm what it's about.
  async function drawCoverPage(doc, opts, photoCount, margin, pageW, pageH, coverRec) {
    const { title, policyHolder, claimNumber, policyNumber, inspectorName, licenseNumber,
      inspectorPhone, inspectorEmail,
      companyName, companyAddress, companyCity, companyState, companyZip,
      companyContact, logoDataUrl, logoPosition = 'left', logoSizePct = 100, ownerPhone,
      propertyAddress: propertyStreet, propertyCity, propertyState, propertyZip } = opts;
    const propertyCSZ = formatCityStateZip(propertyCity, propertyState, propertyZip);
    const companyCSZ = formatCityStateZip(companyCity, companyState, companyZip);
    drawAccentBar(doc, pageW);
    let y = margin;

    let logoRenderH = 0; // tracks logo height when placed right (to push title down)
    if (logoDataUrl) {
      try {
        const { img, width, height } = await loadImageFromDataUrl(logoDataUrl);
        const sizeFactor = Math.max(0.4, Math.min(1.6, (logoSizePct || 100) / 100));
        const maxW = Math.round(220 * sizeFactor);
        const maxH = Math.round(88  * sizeFactor);
        const scale = Math.min(maxW / width, maxH / height, 1);
        const w = width * scale, h = height * scale;
        const pngDataUrl = toPngDataUrl(img, width, height);
        const pos = logoPosition || 'left';
        const logoX = pos === 'center' ? (pageW - w) / 2
                    : pos === 'right'  ? pageW - margin - w
                    : margin;
        doc.addImage(pngDataUrl, 'PNG', logoX, margin, w, h);
        if (pos === 'right') {
          logoRenderH = h; // title will start below the right-placed logo
        } else {
          y += h + 16;    // left/center: advance both columns below the logo
        }
      } catch (err) { console.error(err); }
    }

    // Captured so the "Prepared For" block on the right can start at the same height
    // as the company name on the left, instead of crowding directly under the title.
    const companyStartY = y;

    if (companyName) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(30, 30, 30);
      doc.text(companyName, margin, y);
      y += 16;
    }
    if (companyAddress) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(110, 110, 110);
      doc.text(companyAddress, margin, y);
      y += 14;
    }
    if (companyCSZ) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(110, 110, 110);
      doc.text(companyCSZ, margin, y);
      y += 14;
    }
    if (companyContact) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(110, 110, 110);
      doc.text(companyContact, margin, y);
      y += 14;
    }
    const leftBottom = y;

    // Title sits top-right, alongside the logo/company column rather than centered
    // below it — wraps to multiple lines if it's too wide for the space available
    // next to the logo.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...PDF_ACCENT);
    const titleMaxW = Math.max(pageW - margin * 2 - 220, 140);
    const titleLines = doc.splitTextToSize(title || 'Photo Report', titleMaxW);
    // If logo is right-positioned, push title below the logo height so they don't overlap
    let titleY = (logoRenderH > 0) ? margin + logoRenderH + 8 : margin + 16;
    titleLines.forEach((line) => {
      doc.text(line, pageW - margin, titleY, { align: 'right' });
      titleY += 24;
    });

    // "Report Generated" sits immediately below the title — the rest of the header
    // (Prepared For / address / phone) is positioned lower, aligned to the company
    // info column on the left, so this line doesn't get pushed down with it.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(110, 110, 110);
    const reportGenY = titleY + 6;
    doc.text(`Report Generated: ${new Date().toLocaleString()}`, pageW - margin, reportGenY, { align: 'right' });

    // "Prepared For" block, right-aligned — vertically aligned to start at the same
    // height as the company name on the left (companyStartY) rather than directly
    // under the title, so the two columns read as a matched pair lower on the page.
    // Falls back to just under the Report Generated line if that would overlap.
    let rightY = Math.max(companyStartY, reportGenY + 14);
    if (policyHolder) { doc.text(`Prepared For: ${policyHolder}`, pageW - margin, rightY, { align: 'right' }); rightY += 14; }
    if (propertyStreet) { doc.text(propertyStreet, pageW - margin, rightY, { align: 'right' }); rightY += 14; }
    if (propertyCSZ) { doc.text(propertyCSZ, pageW - margin, rightY, { align: 'right' }); rightY += 14; }
    if (ownerPhone) { doc.text(`Phone: ${ownerPhone}`, pageW - margin, rightY, { align: 'right' }); rightY += 14; }
    const rightBottom = rightY;

    y = Math.max(leftBottom, titleY, rightBottom) + 14;

    doc.setDrawColor(...PDF_ACCENT);
    doc.setLineWidth(1.5);
    doc.line(margin, y, pageW - margin, y);
    doc.setLineWidth(1);
    y += 22;

    // Policy Holder, Property Address, and Phone render in the header block above
    // (right-aligned under the title); Photos Documented and Report Generated have
    // been removed/relocated — kept out of this panel to avoid duplication. Two
    // columns: claim identifiers on the left, inspector identity on the right.
    const leftRows = [];
    if (claimNumber) leftRows.push(['Claim Number:', claimNumber]);
    if (policyNumber) leftRows.push(['Policy Number:', policyNumber]);

    const rightRows = [];
    if (inspectorName) rightRows.push(['Inspector:', licenseNumber ? `${inspectorName} (Lic. #${licenseNumber})` : inspectorName]);
    const inspectorContact = [inspectorPhone, inspectorEmail].filter(Boolean).join('   |   ');
    if (inspectorContact) rightRows.push(['Inspector Contact:', inspectorContact]);

    if (leftRows.length || rightRows.length) {
      // Claim details panel: a soft tinted card behind the label/value rows, with a thin
      // accent rule on the left, so this block reads as a distinct "fact sheet" rather
      // than loose lines of text floating on the page.
      const panelPadY = 14;
      const rowH = 20;
      const panelTop = y;
      const panelRowCount = Math.max(leftRows.length, rightRows.length);
      const panelH = panelRowCount * rowH + panelPadY;
      doc.setFillColor(...PDF_ACCENT_SOFT);
      doc.rect(margin, panelTop, pageW - margin * 2, panelH, 'F');
      doc.setFillColor(...PDF_ACCENT);
      doc.rect(margin, panelTop, 3, panelH, 'F');

      const colGap = 24;
      const colW = (pageW - margin * 2 - colGap) / 2;
      const leftX = margin + 14;
      const rightX = margin + colW + colGap - 15;
      const labelW = 110;
      doc.setFontSize(11);
      y += panelPadY;
      for (let i = 0; i < panelRowCount; i++) {
        if (leftRows[i]) {
          const [label, value] = leftRows[i];
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(...PDF_ACCENT);
          doc.text(label, leftX, y);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(30, 30, 30);
          doc.text(String(value), leftX + labelW, y, { maxWidth: colW - labelW - 14 });
        }
        if (rightRows[i]) {
          const [label, value] = rightRows[i];
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(...PDF_ACCENT);
          doc.text(label, rightX, y);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(30, 30, 30);
          doc.text(String(value), rightX + labelW, y, { maxWidth: colW - labelW + 1 });
        }
        y += rowH;
      }
      y += 12;
    }

    // Optional hero photo (e.g. front-of-property overview) — centered in whatever
    // space remains above the footer.
    if (coverRec) {
      const bottomLimit = pageH - margin;
      const boxY = y + 14;
      const boxH = bottomLimit - boxY;
      const boxW = pageW - margin * 2;
      if (boxH > 60) {
        try {
          const imgEl = await loadImageEl(coverRec.blob);
          const { dataUrl, width, height } = toJpegDataUrl(imgEl.img, imgEl.width, imgEl.height, 1400, 0.85);
          URL.revokeObjectURL(imgEl.url);
          const scale = Math.min(boxW / width, boxH / height, 1);
          const drawW = width * scale;
          const drawH = height * scale;
          const x = margin + (boxW - drawW) / 2;
          const imgY = boxY + (boxH - drawH) / 2;
          doc.addImage(dataUrl, 'JPEG', x, imgY, drawW, drawH);
        } catch (err) { console.error('Cover photo failed', err); }
      }
    }
  }

  async function buildPdfReport(records, opts) {
    records = records.filter((r) => r.kind !== 'video' && r.kind !== 'pdf'); // photo report only — addImage can't render a video/pdf blob
    const { title, policyHolder, claimNumber, perPage } = opts;
    const narrative = (opts.narrative || '').trim();
    const propertyAddress = formatPropertyAddress(opts);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 36;
    const generatedOn = new Date().toLocaleString();

    const [cols, rows] = PDF_LAYOUTS[perPage] || [1, 1];
    const perPageCount = cols * rows;
    const total = records.length;
    const coverRec = opts.coverPhotoId ? records.find((r) => r.id === opts.coverPhotoId) : null;

    // Attachments (weather reports, measurement reports, etc.) are merged in byte-for-byte
    // via pdf-lib rather than flattened to images, so the original document's text/vectors
    // stay intact — this matters because the inspector didn't generate this evidence and
    // shouldn't alter its fidelity. Page counts are read up front so the index/footer page
    // math is correct before any page is drawn.
    const attachmentRecs = (opts.attachments || []).filter((r) => r.kind === 'pdf');
    let attachmentDocs = [];
    if (attachmentRecs.length) {
      if (!window.PDFLib) {
        // pdf-lib failed to load from the CDN (offline, blocked, or the script tag is
        // missing from a stale deploy) — surface this instead of silently dropping the
        // attachments, since a report missing evidence with no warning is the worst outcome.
        console.error('PDFLib is not defined — attachments cannot be merged into this report.');
        toast('Could not load PDF merge library — attachments were skipped');
      } else {
        attachmentDocs = (await Promise.all(attachmentRecs.map(async (rec) => {
          try {
            const bytes = await rec.blob.arrayBuffer();
            const attDoc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
            const pageCount = attDoc.getPageCount() || 1;
            return { rec, bytes, pageCount, dividerPage: 0 };
          } catch (err) {
            console.error('Could not read attached PDF', rec.id, err);
            toast(`"${rec.name || 'Attachment'}" could not be read — skipped`);
            return null;
          }
        }))).filter(Boolean);
      }
    }
    const attachmentPageCount = attachmentDocs.reduce((sum, a) => sum + a.pageCount, 0);

    // Group into the Exterior/Roof/Roof Slopes/Interior/Additional walkthrough order.
    // Divider pages are skipped entirely when nothing is tagged (everything lands in
    // 'other'), so an untagged report renders pixel-identical to the old single-stream
    // report — tagging is additive, never a behavior change for reports that don't use it.
    // groupIntoSections drops empty buckets already, so the only way sections ends up empty
    // is a report with zero photos at all (attachments-only). In that case there's nothing
    // to put a "photos" section/page for — leave sections empty rather than substituting a
    // placeholder, which used to draw one blank page (accent bar + footer, no photos, no
    // divider) ahead of the attachments for no reason.
    let sections = groupIntoSections(records);
    // No photos at all (sections.length === 0) means no divider pages either — there's
    // nothing to divide. (The forEach/for-of loops over `sections` below are already no-ops
    // in that case regardless of this flag, but keep it accurate rather than relying on that.)
    const showDividers = sections.length > 0 && !(sections.length === 1 && sections[0].key === 'other');

    // Narrative pagination, computed up front (needed for the total-page-count footer math)
    const narrativeFontSize = 11;
    const narrativeLineHeight = 16;
    const narrativeHeaderH = 30;
    let narrativeLines = [];
    if (narrative) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(narrativeFontSize);
      narrativeLines = doc.splitTextToSize(narrative, pageW - margin * 2);
    }
    const narrativeLinesPerPage = Math.max(1, Math.floor((pageH - margin * 2 - narrativeHeaderH) / narrativeLineHeight));
    const narrativePageCount = narrativeLines.length ? Math.ceil(narrativeLines.length / narrativeLinesPerPage) : 0;

    let dividerPageCount = 0;
    let photoPageCount = 0;
    sections.forEach((s) => {
      if (showDividers) dividerPageCount += 1;
      photoPageCount += s.records.length ? Math.ceil(s.records.length / perPageCount) : 1;
    });

    // Index page lists each section/attachment and the page it starts on. Shown whenever
    // there's more than one thing to navigate to — section dividers, or attachments, or both.
    const showIndex = showDividers || attachmentDocs.length > 0;
    const indexPageCount = showIndex ? 1 : 0;
    let runningPage = 1 + narrativePageCount + indexPageCount; // cover + narrative + index
    const indexEntries = [];
    if (showDividers) {
      sections.forEach((s) => {
        const startPage = runningPage + 1; // the section's divider page
        const sectionPages = 1 + (s.records.length ? Math.ceil(s.records.length / perPageCount) : 1);
        const endPage = startPage + sectionPages - 1; // last page actually belonging to this section
        runningPage += sectionPages;
        const countLabel = s.records.length === 1 ? '1 photo' : `${s.records.length} photos`;
        indexEntries.push({ title: s.title, page: startPage, endPage, countLabel });
      });
    } else {
      runningPage += photoPageCount; // untagged single-stream report, no dividers to list
    }
    // Attachments section: appended last, after all photo sections, in import order.
    // Each attachment gets its own divider page followed by its real (merged-in) pages.
    // `dividerPage` below is the page NUMBER in the final, post-merge report (used only
    // for the Index display). It must NOT be reused as a pre-merge insertion index: the
    // jsPDF doc we actually build only ever contains one real page per attachment (its
    // divider — the real content pages don't exist yet, they get spliced in afterward by
    // pdf-lib), so dividers sit back-to-back with no filler. `realDividerIndex` captures
    // that true 0-based position so the merge step below inserts in the right place for
    // every attachment, not just the first.
    const pagesBeforeAttachments = runningPage; // real pages drawn so far in the unmerged doc
    attachmentDocs.forEach((att, i) => {
      const startPage = runningPage + 1; // the attachment's own divider page (final numbering)
      att.dividerPage = startPage;
      att.realDividerIndex = pagesBeforeAttachments + i; // 0-based, in the unmerged doc
      const endPage = startPage + att.pageCount; // divider page + its real merged-in pages
      runningPage += 1 + att.pageCount;
      const countLabel = att.pageCount === 1 ? '1 page' : `${att.pageCount} pages`;
      indexEntries.push({ title: att.rec.name || 'Attachment', page: startPage, endPage, countLabel });
    });

    const totalPages = 1 + narrativePageCount + indexPageCount + dividerPageCount + photoPageCount
      + attachmentDocs.length + attachmentPageCount; // +1 for cover

    await drawCoverPage(doc, opts, total, margin, pageW, pageH, coverRec);
    drawFooter(doc, margin, pageW, pageH, 1, totalPages, generatedOn);
    let pageNum = 1;

    // Narrative Summary page(s) — right after the cover, before any photos, so the
    // reader gets the story of the inspection before seeing the evidence.
    for (let np = 0; np < narrativePageCount; np++) {
      doc.addPage();
      pageNum++;
      drawAccentBar(doc, pageW);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(...PDF_ACCENT);
      doc.text(np === 0 ? 'Narrative Summary' : 'Narrative Summary (continued)', margin, margin);
      doc.setDrawColor(...PDF_ACCENT);
      doc.setLineWidth(1.5);
      doc.line(margin, margin + 16, pageW - margin, margin + 16);
      doc.setLineWidth(1);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(narrativeFontSize);
      doc.setTextColor(40, 40, 40);
      const startLine = np * narrativeLinesPerPage;
      const pageLines = narrativeLines.slice(startLine, startLine + narrativeLinesPerPage);
      let ty = margin + narrativeHeaderH;
      pageLines.forEach((line) => {
        doc.text(line, margin, ty);
        ty += narrativeLineHeight;
      });
      drawFooter(doc, margin, pageW, pageH, pageNum, totalPages, generatedOn);
    }

    // Index — one line per section with its starting page number, so the report can be
    // navigated without paging through it.
    if (indexPageCount) {
      doc.addPage();
      pageNum++;
      drawAccentBar(doc, pageW);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(...PDF_ACCENT);
      doc.text('Index', margin, margin);
      doc.setDrawColor(...PDF_ACCENT);
      doc.setLineWidth(1.5);
      doc.line(margin, margin + 16, pageW - margin, margin + 16);
      doc.setLineWidth(1);
      let iy = margin + 44;
      // Long attachment filenames used to overlap the page-count/page-number columns since
      // the title was printed at full width with no wrap. Wrap it to a fixed column width
      // (clear of the countLabel column at margin+220) and grow the row to fit.
      const indexTitleMaxW = 195;
      const indexLineH = 14;
      indexEntries.forEach((entry) => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(30, 30, 30);
        const titleLines = doc.splitTextToSize(entry.title, indexTitleMaxW);
        titleLines.forEach((line, i) => doc.text(line, margin, iy + i * indexLineH));
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        doc.setTextColor(120, 120, 120);
        doc.text(entry.countLabel, margin + 220, iy);
        const pageLabel = entry.endPage > entry.page
          ? `Pages ${entry.page}-${entry.endPage}`
          : `Page ${entry.page}`;
        doc.text(pageLabel, pageW - margin, iy, { align: 'right' });
        const rowH = 28 + (titleLines.length - 1) * indexLineH;
        doc.setDrawColor(225, 225, 225);
        doc.line(margin, iy + rowH - 20, pageW - margin, iy + rowH - 20);
        iy += rowH;
      });
      drawFooter(doc, margin, pageW, pageH, pageNum, totalPages, generatedOn);
    }

    // No page-wide header on photo pages: title/policy holder/property/claim # already
    // appear once on the cover page (drawCoverPage), so repeating them on every photo
    // page was redundant. That space is now used by each photo's own description.
    const captionH = perPageCount === 1 ? 30 : 24;   // bottom: name + date, tight under the photo
    const topCapH = perPageCount === 1 ? 34 : 27;    // top: category, room/elevation
    const fontCaption = perPageCount === 1 ? 12 : 9;
    const fontDate = perPageCount === 1 ? 9 : 7;
    const imgMaxDim = perPageCount === 1 ? 1600 : 1000;

    for (const section of sections) {
      if (showDividers) {
        doc.addPage();
        pageNum++;
        drawAccentBar(doc, pageW);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(22);
        doc.setTextColor(...PDF_ACCENT);
        doc.text(section.title, pageW / 2, pageH / 2 - 16, { align: 'center' });
        const countLabel = section.records.length === 1 ? '1 photo' : `${section.records.length} photos`;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        const badgeW = doc.getTextWidth(countLabel) + 24;
        const badgeH = 20;
        const badgeX = pageW / 2 - badgeW / 2;
        const badgeY = pageH / 2;
        doc.setFillColor(...PDF_ACCENT_SOFT);
        doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 10, 10, 'F');
        doc.setTextColor(...PDF_ACCENT);
        doc.text(countLabel, pageW / 2, badgeY + badgeH / 2 + 3.5, { align: 'center' });
        drawFooter(doc, margin, pageW, pageH, pageNum, totalPages, generatedOn);
      }

      const sectionPageCount = section.records.length ? Math.ceil(section.records.length / perPageCount) : 1;
      let sectionPhotoIndex = 0;

      for (let page = 0; page < sectionPageCount; page++) {
        doc.addPage();
        pageNum++;
        drawAccentBar(doc, pageW);
        drawFooter(doc, margin, pageW, pageH, pageNum, totalPages, generatedOn);

        const contentTop = margin;
        const contentW = pageW - margin * 2;
        const contentH = pageH - margin * 2;
        const cellW = contentW / cols;
        const cellH = contentH / rows;
        const cellPad = 6;
        const cardGutter = 4; // leaves a visible gap between adjacent photo cards

        for (let cellIdx = 0; cellIdx < perPageCount && sectionPhotoIndex < section.records.length; cellIdx++, sectionPhotoIndex++) {
          const rec = section.records[sectionPhotoIndex];
          const r = Math.floor(cellIdx / cols);
          const c = cellIdx % cols;
          const cellX = margin + c * cellW;
          const cellY = contentTop + r * cellH;
          const imgBoxX = cellX + cellPad;
          const imgBoxY = cellY + cellPad + topCapH;
          const imgBoxW = cellW - cellPad * 2;
          const imgBoxH = cellH - cellPad * 2 - topCapH - captionH;

          // Card background behind the whole cell — a plain page of loose text/photos
          // reads as unfinished; a bordered card per photo gives the grid visual structure.
          doc.setFillColor(250, 250, 252);
          doc.setDrawColor(214, 219, 228);
          doc.setLineWidth(0.75);
          doc.roundedRect(cellX + cardGutter, cellY + cardGutter, cellW - cardGutter * 2, cellH - cardGutter * 2, 4, 4, 'FD');
          doc.setLineWidth(1);

          // Top, above the photo: category (left-aligned, in the report's accent color),
          // room/elevation under it with a clear gap so it doesn't crowd the category line.
          const catY = cellY + cellPad + fontCaption + 2;
          const roomGap = perPageCount === 1 ? 14 : 11;
          const roomY = catY + roomGap;
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(fontCaption);
          doc.setTextColor(...PDF_ACCENT);
          doc.text(section.title, cellX + cellPad + 2, catY, { maxWidth: cellW - cellPad * 2 - 4 });
          let roomLabel = '';
          if (rec.category === 'exterior' && rec.subLocation) roomLabel = `${rec.subLocation} Elevation`;
          else if (rec.category === 'interior' && rec.subLocation) roomLabel = rec.subLocation;
          if (roomLabel) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(fontDate);
            doc.setTextColor(110, 110, 110);
            doc.text(roomLabel, cellX + cellPad + 2, roomY, { maxWidth: cellW - cellPad * 2 - 4 });
          }

          try {
            const imgEl = await loadImageEl(rec.blob);
            // Cover-fit (center-crop to the box's own aspect ratio) instead of "contain":
            // every photo on a multi-photo page now renders at the exact same width and
            // height, regardless of whether the original shot was portrait or landscape.
            const dataUrl = toCoverFitJpegDataUrl(imgEl.img, imgEl.width, imgEl.height, imgBoxW, imgBoxH, imgMaxDim, 0.82);
            URL.revokeObjectURL(imgEl.url);
            const x = imgBoxX, y = imgBoxY, drawW = imgBoxW, drawH = imgBoxH;
            doc.addImage(dataUrl, 'JPEG', x, y, drawW, drawH);

            // Compass heading overlaid in the photo's top-right corner — shown on any
            // photo that has a captured heading, not just ones tagged "exterior" (a
            // Roof or Interior photo taken with the compass on still has a real
            // heading and was previously dropped here even though it printed during capture).
            if (rec.heading != null) {
              const headingLabel = cardinal(rec.heading) + ' ' + Math.round(rec.heading) + '°';
              doc.setFont('helvetica', 'bold');
              doc.setFontSize(fontDate);
              const hW = doc.getTextWidth(headingLabel);
              const hPadX = 4, hPadY = 3;
              const hChipW = Math.min(hW + hPadX * 2, drawW - 4);
              const hChipH = fontDate + hPadY * 2 - 1;
              const hChipX = x + drawW - hChipW - 2;
              const hChipY = y + 2;
              doc.setGState(new doc.GState({ opacity: 0.6 }));
              doc.setFillColor(0, 0, 0);
              doc.rect(hChipX, hChipY, hChipW, hChipH, 'F');
              doc.setGState(new doc.GState({ opacity: 1 }));
              doc.setTextColor(255, 255, 255);
              doc.setFont('helvetica', 'bold');
              doc.setFontSize(fontDate);
              doc.text(headingLabel, hChipX + hPadX, hChipY + hPadY + fontDate - 1, { maxWidth: hChipW - hPadX * 2 });
            }

            // Name + date sit immediately under the photo, tight against its bottom edge
            // (rather than far down in the cell), so the caption reads as belonging to
            // this specific photo.
            const nameY = y + drawH + fontCaption + 2;
            const dateY = nameY + fontDate + 3;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(fontCaption);
            doc.setTextColor(20, 20, 20);
            doc.text(rec.name || 'Untitled', cellX + cellW / 2, nameY, { align: 'center', maxWidth: cellW - cellPad * 2 });
            if (rec.createdAt) {
              doc.setFont('helvetica', 'normal');
              doc.setFontSize(fontDate);
              doc.setTextColor(130, 130, 130);
              doc.text(new Date(rec.createdAt).toLocaleDateString(), cellX + cellW / 2, dateY, { align: 'center' });
            }
          } catch (err) {
            console.error('PDF image failed for', rec.id, err);
            doc.setFontSize(fontCaption);
            doc.setTextColor(180, 60, 60);
            doc.text('Photo could not be loaded', cellX + cellW / 2, cellY + cellH / 2, { align: 'center' });
          }
        }
      }
    }

    // Attachments section — one divider page per attached PDF, in import order. The real
    // pages of each attachment get spliced in right after its divider during the pdf-lib
    // merge pass below; pageNum is advanced past them here so later footers stay correct.
    for (const att of attachmentDocs) {
      doc.addPage();
      pageNum++;
      // Long attachment filenames could previously run off the page or overlap the page-count
      // line below since the title was printed on one line with no wrap. Wrap it to the page
      // width and center the whole block (title + page-count) on the divider page.
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(22);
      doc.setTextColor(30, 30, 30);
      const attNameMaxW = pageW - margin * 2 - 40;
      const attNameLines = doc.splitTextToSize(att.rec.name || 'Attachment', attNameMaxW);
      const attNameLineH = 26;
      const attNameStartY = pageH / 2 - 10 - ((attNameLines.length - 1) * attNameLineH) / 2;
      attNameLines.forEach((line, i) => {
        doc.text(line, pageW / 2, attNameStartY + i * attNameLineH, { align: 'center' });
      });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      doc.setTextColor(120, 120, 120);
      const attPagesY = attNameStartY + (attNameLines.length - 1) * attNameLineH + 28;
      doc.text(att.pageCount === 1 ? '1 page' : `${att.pageCount} pages`, pageW / 2, attPagesY, { align: 'center' });
      drawFooter(doc, margin, pageW, pageH, pageNum, totalPages, generatedOn);
      pageNum += att.pageCount;
    }

    if (!attachmentDocs.length) return doc.output('blob');

    // Merge pass: splice each attachment's actual pages (text/vectors intact, not
    // flattened to images) in right after its divider page. Insertion shifts every
    // later index, so insertOffset accumulates as attachments are spliced in, in order.
    const mainBytes = doc.output('arraybuffer');
    const merged = await PDFLib.PDFDocument.load(mainBytes);
    let insertOffset = 0;
    for (const att of attachmentDocs) {
      // realDividerIndex is the divider's true 0-based position in the unmerged doc;
      // +1 moves to right after it, +insertOffset accounts for pages already spliced in
      // by earlier attachments in this same loop (dividerPage/the final page NUMBER must
      // NOT be used here — see note above where it's computed).
      const insertAt = att.realDividerIndex + 1 + insertOffset;
      try {
        const attDoc = await PDFLib.PDFDocument.load(att.bytes, { ignoreEncryption: true });
        const indices = attDoc.getPageIndices();
        const copiedPages = await merged.copyPages(attDoc, indices);
        copiedPages.forEach((p, i) => merged.insertPage(insertAt + i, p));
        insertOffset += copiedPages.length;
      } catch (err) {
        // A single malformed/unsupported page can make pdf-lib throw for the whole batch
        // copyPages() call, which previously dropped every page of that attachment even
        // though most of them were fine. Fall back to copying page-by-page so only the
        // specific page(s) that actually fail get skipped, instead of the whole document.
        console.error('Batch merge failed for attached PDF, retrying page-by-page', att.rec.id, err);
        let copiedCount = 0;
        const failedPages = [];
        try {
          const attDoc = await PDFLib.PDFDocument.load(att.bytes, { ignoreEncryption: true });
          for (const idx of attDoc.getPageIndices()) {
            try {
              const [p] = await merged.copyPages(attDoc, [idx]);
              merged.insertPage(insertAt + copiedCount, p);
              copiedCount++;
            } catch (pageErr) {
              console.error('Could not copy page', idx, 'of attached PDF', att.rec.id, pageErr);
              failedPages.push(idx + 1);
            }
          }
        } catch (reloadErr) {
          console.error('Could not reload attached PDF for page-by-page merge', att.rec.id, reloadErr);
        }
        insertOffset += copiedCount;
        if (copiedCount === 0) {
          toast(`"${att.rec.name || 'Attachment'}" could not be merged — skipped`);
        } else if (failedPages.length) {
          toast(`"${att.rec.name || 'Attachment'}": page(s) ${failedPages.join(', ')} could not be merged — rest included`);
        }
      }
    }
    const mergedBytes = await merged.save();
    return new Blob([mergedBytes], { type: 'application/pdf' });
  }

  async function sharePdf(blob, filenameBase) {
    const stamp = new Date().toISOString().slice(0, 10);
    const file = new File([blob], `${filenameBase}-${stamp}.pdf`, { type: 'application/pdf' });
    if (canUseFileShareSheet([file])) {
      await navigator.share({ files: [file], title: 'Photo Report' });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  /* ---------------- PDF options modal ---------------- */
  const pdfEls = {
    modal: document.getElementById('pdf-modal'),
    card: document.getElementById('pdf-card'),
    scanSource: document.getElementById('pdf-scan-source'),
    scanDocPicker: document.getElementById('pdf-scan-doc-picker'),
    scanStatus: document.getElementById('pdf-scan-status'),
    titleInput: document.getElementById('pdf-title-input'),
    policyInput: document.getElementById('pdf-policyholder-input'),
    claimInput: document.getElementById('pdf-claim-input'),
    policyNumberInput: document.getElementById('pdf-policy-number-input'),
    policyNumberMic: document.getElementById('pdf-policy-number-mic'),
    addressInput: document.getElementById('pdf-address-input'),
    cityInput: document.getElementById('pdf-city-input'),
    stateInput: document.getElementById('pdf-state-input'),
    stateMic: document.getElementById('pdf-state-mic'),
    zipInput: document.getElementById('pdf-zip-input'),
    zipMic: document.getElementById('pdf-zip-mic'),
    ownerPhoneInput: document.getElementById('pdf-owner-phone-input'),
    infoForm: document.getElementById('pdf-info-form'),
    titleMic: document.getElementById('pdf-title-mic'),
    policyMic: document.getElementById('pdf-policyholder-mic'),
    claimMic: document.getElementById('pdf-claim-mic'),
    addressMic: document.getElementById('pdf-address-mic'),
    cityMic: document.getElementById('pdf-city-mic'),
    ownerPhoneMic: document.getElementById('pdf-owner-phone-mic'),
    perPageOpts: document.getElementById('pdf-per-page-options'),
    inspectorInput: document.getElementById('pdf-inspector-input'),
    inspectorMic: document.getElementById('pdf-inspector-mic'),
    licenseInput: document.getElementById('pdf-license-input'),
    licenseMic: document.getElementById('pdf-license-mic'),
    inspectorPhoneInput: document.getElementById('pdf-inspector-phone-input'),
    inspectorPhoneMic: document.getElementById('pdf-inspector-phone-mic'),
    inspectorEmailInput: document.getElementById('pdf-inspector-email-input'),
    inspectorEmailMic: document.getElementById('pdf-inspector-email-mic'),
    companyInput: document.getElementById('pdf-company-input'),
    companyMic: document.getElementById('pdf-company-mic'),
    companyAddressInput: document.getElementById('pdf-company-address-input'),
    companyAddressMic: document.getElementById('pdf-company-address-mic'),
    companyCityInput: document.getElementById('pdf-company-city-input'),
    companyCityMic: document.getElementById('pdf-company-city-mic'),
    companyStateInput: document.getElementById('pdf-company-state-input'),
    companyStateMic: document.getElementById('pdf-company-state-mic'),
    companyZipInput: document.getElementById('pdf-company-zip-input'),
    companyZipMic: document.getElementById('pdf-company-zip-mic'),
    contactInput: document.getElementById('pdf-contact-input'),
    contactMic: document.getElementById('pdf-contact-mic'),
    narrativeInput: document.getElementById('pdf-narrative-input'),
    narrativeMic: document.getElementById('pdf-narrative-mic'),
    logoPick: document.getElementById('pdf-logo-pick'),
    logoClear: document.getElementById('pdf-logo-clear'),
    logoFile: document.getElementById('pdf-logo-file'),
    logoPreview: document.getElementById('pdf-logo-preview'),
    logoPreviewImg: document.getElementById('pdf-logo-preview-img'),
    logoControls: document.getElementById('pdf-logo-controls'),
    logoPosRow: document.getElementById('pdf-logo-pos-row'),
    logoSizeSlider: document.getElementById('pdf-logo-size-slider'),
    logoSizeVal: document.getElementById('pdf-logo-size-val'),
    coverPhotoStrip: document.getElementById('pdf-coverphoto-strip'),
    cancel: document.getElementById('pdf-cancel'),
    saveCamera: document.getElementById('pdf-save-camera'),
    generate: document.getElementById('pdf-generate'),
    previewModal: document.getElementById('pdf-preview-modal'),
    previewFrame: document.getElementById('pdf-preview-frame'),
    previewBack: document.getElementById('pdf-preview-back'),
    previewSend: document.getElementById('pdf-preview-send'),
    saveProfileBtn: document.getElementById('pdf-save-profile-btn'),
  };
  let pdfPendingRecords = null;
  let pdfPendingAttachments = null;
  let pdfPerPage = 1;
  let pdfCoverPhotoId = null;
  let pdfCoverPhotoUrls = []; // object URLs for the thumbnail strip, revoked when the modal closes
  // Holds the built report between "Preview" and "Save & Send" so the PDF isn't regenerated
  // (and the fields can't drift from what's actually on screen) when the user confirms it.
  let pdfPreviewBlob = null;
  let pdfPreviewOpts = null;

  // Cover-page identity (inspector/company/logo) rarely changes between reports, so it's
  // persisted locally and pre-filled every time the options screen opens — only the
  // per-claim fields above (title, policy holder, claim #, address) reset each time.
  const PDF_PREFS_KEY = 'pn_pdfCoverPrefs';
  function loadPdfPrefs() {
    try { return JSON.parse(localStorage.getItem(PDF_PREFS_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePdfPrefs(prefs) {
    try { localStorage.setItem(PDF_PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
  }
  let pdfLogoDataUrl = null;
  let pdfLogoPosition = 'left';   // 'left' | 'center' | 'right'
  let pdfLogoSizePct  = 100;      // 40–160, maps to a scale factor

  function applyLogoPreview() {
    if (pdfLogoDataUrl) {
      pdfEls.logoPreviewImg.src = pdfLogoDataUrl;
      pdfEls.logoPreview.classList.remove('hidden');
      if (pdfEls.logoControls) pdfEls.logoControls.classList.remove('hidden');
    } else {
      pdfEls.logoPreviewImg.src = '';
      pdfEls.logoPreview.classList.add('hidden');
      if (pdfEls.logoControls) pdfEls.logoControls.classList.add('hidden');
    }
  }

  function applyLogoPosUI(pos) {
    if (!pdfEls.logoPosRow) return;
    pdfEls.logoPosRow.querySelectorAll('.logo-pos-btn').forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.pos === pos);
    });
  }

  pdfEls.logoPick.addEventListener('click', () => pdfEls.logoFile.click());
  pdfEls.logoFile.addEventListener('change', () => {
    const file = pdfEls.logoFile.files && pdfEls.logoFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pdfLogoDataUrl = reader.result;
      applyLogoPreview();
      const prefs = loadPdfPrefs();
      prefs.logoDataUrl = pdfLogoDataUrl;
      savePdfPrefs(prefs);
    };
    reader.readAsDataURL(file);
    pdfEls.logoFile.value = '';
  });
  pdfEls.logoClear.addEventListener('click', () => {
    pdfLogoDataUrl = null;
    applyLogoPreview();
    const prefs = loadPdfPrefs();
    delete prefs.logoDataUrl;
    savePdfPrefs(prefs);
  });

  // Position buttons
  if (pdfEls.logoPosRow) {
    pdfEls.logoPosRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.logo-pos-btn');
      if (!btn) return;
      pdfLogoPosition = btn.dataset.pos;
      applyLogoPosUI(pdfLogoPosition);
    });
  }

  // Size slider
  if (pdfEls.logoSizeSlider) {
    pdfEls.logoSizeSlider.addEventListener('input', () => {
      pdfLogoSizePct = Number(pdfEls.logoSizeSlider.value);
      if (pdfEls.logoSizeVal) pdfEls.logoSizeVal.textContent = pdfLogoSizePct;
    });
  }

  // Lets the user pick one of the photos already in this report as a hero image on the
  // cover sheet (e.g. a front-of-property shot) — built from pdfPendingRecords rather than
  // a full gallery browser, since those are the only photos relevant to this report.
  function buildCoverPhotoStrip(records) {
    pdfCoverPhotoUrls.forEach((url) => URL.revokeObjectURL(url));
    pdfCoverPhotoUrls = [];
    pdfEls.coverPhotoStrip.querySelectorAll('img.pdf-coverphoto-thumb').forEach((el) => el.remove());
    const noneBtn = pdfEls.coverPhotoStrip.querySelector('.pdf-coverphoto-none');
    records.forEach((rec) => {
      const url = URL.createObjectURL(rec.blob);
      pdfCoverPhotoUrls.push(url);
      const img = document.createElement('img');
      img.className = 'pdf-coverphoto-thumb';
      img.src = url;
      img.dataset.id = rec.id;
      pdfEls.coverPhotoStrip.appendChild(img);
    });
    setCoverPhotoSelection(null);
    void noneBtn;
  }

  function setCoverPhotoSelection(id) {
    pdfCoverPhotoId = id || null;
    pdfEls.coverPhotoStrip.querySelectorAll('.pdf-coverphoto-thumb').forEach((el) => {
      el.classList.toggle('selected', (el.dataset.id || '') === (pdfCoverPhotoId || ''));
    });
  }

  pdfEls.coverPhotoStrip.addEventListener('click', (e) => {
    const el = e.target.closest('.pdf-coverphoto-thumb');
    if (!el) return;
    setCoverPhotoSelection(el.dataset.id || null);
  });

  // Lets a single text field be filled by voice. Independent from the naming-flow
  // recognizer: each tap is its own fresh user gesture, so it can start immediately
  // without the gesture/teardown juggling the import queue needs.
  function attachDictation(button, input) {
    if (!button) return;
    let rec = null;
    let active = false;
    button.addEventListener('click', () => {
      if (!speechSupported) {
        alert('Speech recognition is not supported in this browser — type instead.');
        return;
      }
      if (active) {
        try { rec && rec.abort(); } catch (e) {}
        return;
      }
      rec = new SpeechRecognitionImpl();
      rec.lang = 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let finalText = '';
        let interimText = '';
        for (let i = 0; i < e.results.length; i++) {
          const piece = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += piece + ' ';
          else interimText += piece;
        }
        input.value = (finalText + interimText).trim();
        // Dictation sets .value directly, which doesn't fire native 'input' listeners —
        // dispatch one so live filters/autofill flags tied to typing also react to speech.
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      rec.onerror = (e) => console.warn('dictation error', e.error);
      rec.onend = () => {
        active = false;
        button.classList.remove('listening');
      };
      try {
        rec.start();
        active = true;
        button.classList.add('listening');
      } catch (err) {
        console.error(err);
      }
    });
  }
  // Chains dictation across the PDF report's text fields, in reading order, so filling the
  // form out by voice doesn't require hunting down each field's own mic button in turn.
  // Tapping the active (red) mic button again finalizes that field AND immediately starts
  // listening on the next field — one tap per field instead of "stop here, find the next
  // button, start there". Tapping it again right away (nothing said) just skips that field
  // and moves to the one after. Reuses the same abort()-then-wait-for-onend handshake the
  // main photo-naming flow uses (see recognitionTornDown above) since iOS drops a new
  // recognition session started before the previous one has actually released the mic.
  function setupDictationChain(fields) {
    let activeIdx = -1;
    let rec = null;
    let tornDown = true;

    function startField(idx) {
      if (idx < 0 || idx >= fields.length) { activeIdx = -1; return; }
      if (!speechSupported) {
        alert('Speech recognition is not supported in this browser — type instead.');
        return;
      }
      const { button, input } = fields[idx];
      input.focus({ preventScroll: true });
      if (input.scrollIntoView) input.scrollIntoView({ block: 'center', behavior: 'smooth' });

      const begin = () => {
        try {
          rec = new SpeechRecognitionImpl();
          rec.lang = 'en-US';
          rec.continuous = true;
          rec.interimResults = true;
          rec.onresult = (e) => {
            let finalText = '';
            let interimText = '';
            for (let i = 0; i < e.results.length; i++) {
              const piece = e.results[i][0].transcript;
              if (e.results[i].isFinal) finalText += piece + ' ';
              else interimText += piece;
            }
            input.value = (finalText + interimText).trim();
            input.dispatchEvent(new Event('input', { bubbles: true }));
          };
          rec.onerror = (e) => console.warn('dictation error', e.error);
          rec.onend = () => {
            tornDown = true;
            if (activeIdx === idx) {
              activeIdx = -1;
              button.classList.remove('listening');
              button.textContent = '🎤';
              button.title = 'Speak';
            }
          };
          rec.start();
          tornDown = false;
          activeIdx = idx;
          button.classList.add('listening');
          button.textContent = '➡️';
          button.title = 'Tap to confirm and continue';
        } catch (err) {
          console.error(err);
          setTimeout(begin, 300);
        }
      };

      if (tornDown) {
        begin();
      } else {
        let started = false;
        const tryBegin = () => {
          if (started) return;
          started = true;
          clearInterval(poll);
          clearTimeout(fallback);
          begin();
        };
        const poll = setInterval(() => { if (tornDown) tryBegin(); }, 50);
        const fallback = setTimeout(tryBegin, 400);
      }
    }

    function stopActive() {
      if (rec) { try { rec.abort(); } catch (e) {} }
    }

    fields.forEach(({ button }, idx) => {
      if (!button) return;
      button.addEventListener('click', () => {
        if (activeIdx === idx) {
          stopActive();
          startField(idx + 1);
        } else {
          stopActive();
          startField(idx);
        }
      });
    });

    // Lets something outside the chain (Google address autofill) skip straight to a
    // given field — e.g. past city/state/zip once those were just auto-filled — the
    // same way tapping "confirm and continue" through each of them would. Only takes
    // over if the chain is actually mid-dictation (activeIdx !== -1); if the adjuster
    // never engaged voice at all, returns false so the caller just moves plain focus
    // instead of unexpectedly kicking off a mic/listening session.
    function jumpTo(targetInput) {
      const targetIdx = fields.findIndex((f) => f.input === targetInput);
      if (targetIdx === -1 || activeIdx === -1) return false;
      stopActive();
      startField(targetIdx);
      return true;
    }

    // Lets the caller release the mic when leaving this chain's screen entirely (e.g.
    // closing the PDF modal) — without this, a field's recognition left active by tapping
    // away (instead of "confirm and continue") keeps holding the mic, and the very next
    // recognition started anywhere else in the app (the camera's photo-naming mic, for
    // instance) gets silently dropped by iOS because the previous session hasn't released
    // it yet. No-op if nothing is active.
    function stop() {
      if (activeIdx === -1) return;
      stopActive();
      activeIdx = -1;
    }

    return { jumpTo, stop };
  }

  const pdfDictationChain = setupDictationChain([
    { button: pdfEls.titleMic, input: pdfEls.titleInput },
    { button: pdfEls.policyMic, input: pdfEls.policyInput },
    { button: pdfEls.addressMic, input: pdfEls.addressInput },
    { button: pdfEls.cityMic, input: pdfEls.cityInput },
    { button: pdfEls.stateMic, input: pdfEls.stateInput },
    { button: pdfEls.zipMic, input: pdfEls.zipInput },
    { button: pdfEls.claimMic, input: pdfEls.claimInput },
    { button: pdfEls.policyNumberMic, input: pdfEls.policyNumberInput },
    { button: pdfEls.ownerPhoneMic, input: pdfEls.ownerPhoneInput },
    { button: pdfEls.narrativeMic, input: pdfEls.narrativeInput },
    { button: pdfEls.companyMic, input: pdfEls.companyInput },
    { button: pdfEls.companyAddressMic, input: pdfEls.companyAddressInput },
    { button: pdfEls.companyCityMic, input: pdfEls.companyCityInput },
    { button: pdfEls.companyStateMic, input: pdfEls.companyStateInput },
    { button: pdfEls.companyZipMic, input: pdfEls.companyZipInput },
    { button: pdfEls.contactMic, input: pdfEls.contactInput },
    { button: pdfEls.inspectorMic, input: pdfEls.inspectorInput },
    { button: pdfEls.licenseMic, input: pdfEls.licenseInput },
    { button: pdfEls.inspectorPhoneMic, input: pdfEls.inspectorPhoneInput },
    { button: pdfEls.inspectorEmailMic, input: pdfEls.inspectorEmailInput },
  ]);

  // Auto-formats a phone field to XXX-XXX-XXXX as digits arrive — whether typed,
  // pasted, dictated (attachDictation/setupDictationChain both dispatch a real
  // 'input' event on speech, so this listener catches voice entry too), or filled
  // by the document-scan autofill below (fillIfEmpty also dispatches 'input').
  function formatPhoneNumber(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  function attachPhoneFormatting(input) {
    if (!input) return;
    input.addEventListener('input', () => {
      const formatted = formatPhoneNumber(input.value);
      if (formatted !== input.value) {
        input.value = formatted;
        // Cursor at the end — phone numbers are short enough that mid-string editing
        // doesn't need finer cursor preservation, and this keeps typing/dictation smooth.
        input.setSelectionRange(formatted.length, formatted.length);
      }
    });
  }
  attachPhoneFormatting(pdfEls.ownerPhoneInput);
  attachPhoneFormatting(pdfEls.inspectorPhoneInput);
  attachPhoneFormatting(els.setupInspectorPhoneInput);
  attachPhoneFormatting(els.stgInspectorPhoneInput);

  // "Scan policy/estimate to autofill" — reads a photographed/scanned PDF (declarations
  // page, repair estimate) via a server-side Claude call and fills the policyholder/
  // address/claim/phone fields from whatever the document actually states. Never silently
  // overwrites a field the adjuster already filled in by hand — those are left alone so a
  // scan can't clobber something already confirmed correct.
  const SCAN_DOC_FUNCTION_URL = 'https://dapper-hummingbird-736d0d.netlify.app/.netlify/functions/extract-document-info';

  function setScanStatus(msg, isError) {
    if (!pdfEls.scanStatus) return;
    pdfEls.scanStatus.textContent = msg || '';
    pdfEls.scanStatus.classList.toggle('error', !!isError);
  }

  function fillIfEmpty(input, value) {
    if (!input || value == null || value === '') return false;
    if (input.value && input.value.trim()) return false; // don't clobber an existing answer
    input.value = String(value).trim();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // dataURL looks like "data:application/pdf;base64,XXXX" — the API only wants the part after the comma.
        const result = String(reader.result || '');
        const idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  // Populates the scan dropdown each time the modal opens (called from openPdfOptions
  // below) with whatever PDFs are already attached to this folder, so the adjuster can
  // scan something already imported instead of having to re-pick the same file.
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function refreshScanSourceOptions() {
    if (!pdfEls.scanSource) return;
    const attachments = pdfPendingAttachments || [];
    pdfEls.scanSource.innerHTML =
      '<option value="">📄 Scan a document to autofill…</option>' +
      '<option value="__upload__">Upload a new PDF…</option>' +
      attachments.map((rec, i) => `<option value="att_${i}">Use attached: ${escapeHtml(rec.name || 'PDF')}</option>`).join('');
  }

  async function runScan(blob, displayName) {
    if (!pdfEls.scanSource) return;
    pdfEls.scanSource.disabled = true;
    setScanStatus('Reading document…');
    try {
      const pdfBase64 = await readFileAsBase64(blob);
      setScanStatus('Scanning — this can take a few seconds…');
      const res = await fetch(SCAN_DOC_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');

      const f = data.fields || {};
      let filled = 0;
      if (fillIfEmpty(pdfEls.policyInput, f.policyHolderName)) filled++;
      if (fillIfEmpty(pdfEls.claimInput, f.claimNumber)) filled++;
      if (fillIfEmpty(pdfEls.policyNumberInput, f.policyNumber)) filled++;
      if (fillIfEmpty(pdfEls.addressInput, f.propertyAddress)) filled++;
      if (fillIfEmpty(pdfEls.cityInput, f.city)) filled++;
      if (fillIfEmpty(pdfEls.stateInput, f.state)) filled++;
      if (fillIfEmpty(pdfEls.zipInput, f.zip)) filled++;
      if (fillIfEmpty(pdfEls.ownerPhoneInput, f.ownerPhone)) filled++;

      if (filled) {
        setScanStatus(`Filled ${filled} field${filled === 1 ? '' : 's'} from "${displayName}" — please review before generating the report.`);
      } else {
        setScanStatus('No matching fields found in that document — nothing was filled.', true);
      }
    } catch (err) {
      console.error('Document scan failed', err);
      setScanStatus('Could not scan that document — type the fields in manually.', true);
    } finally {
      pdfEls.scanSource.disabled = false;
    }
  }

  if (pdfEls.scanSource && pdfEls.scanDocPicker) {
    pdfEls.scanSource.addEventListener('change', () => {
      const val = pdfEls.scanSource.value;
      pdfEls.scanSource.value = ''; // reset to placeholder right away so it can be re-used
      if (!val) return;
      if (val === '__upload__') {
        pdfEls.scanDocPicker.click();
        return;
      }
      if (val.startsWith('att_')) {
        const idx = Number(val.slice(4));
        const rec = (pdfPendingAttachments || [])[idx];
        if (rec && rec.blob) runScan(rec.blob, rec.name || 'attached PDF');
      }
    });

    pdfEls.scanDocPicker.addEventListener('change', () => {
      const file = pdfEls.scanDocPicker.files && pdfEls.scanDocPicker.files[0];
      pdfEls.scanDocPicker.value = '';
      if (!file) return;
      runScan(file, file.name);
    });
  }

  // Google Places autocomplete on the property address field — as the adjuster types a
  // street address, Google suggests real matching addresses; picking one fills street,
  // city, state, and zip directly (this is an explicit user choice, unlike the PDF scan,
  // so it overwrites whatever was already in those fields rather than leaving them alone).
  // Wired up via a named global callback because the Google Maps script tag in index.html
  // loads asynchronously — see the <script ... callback=initGoogleAutocomplete> tag there.
  // Google's suggestion dropdown (.pac-container) is appended directly to <body>,
  // outside the PDF options card, and is positioned once at open time then only
  // re-tracked on window scroll/resize. Our card scrolls internally (max-height +
  // overflow-y:auto), which doesn't fire a window scroll event, so the dropdown can
  // get left floating in the wrong spot — looking like it "won't go away" — once the
  // card scrolls or the modal closes underneath it. Hide it ourselves in those cases
  // rather than relying on Google's own (window-scroll-only) dismissal.
  function hidePacSuggestions() {
    document.querySelectorAll('.pac-container').forEach((el) => { el.style.display = 'none'; });
  }

  // Shared wiring for one address field + its city/state/zip group. After a suggestion
  // is picked, city/state/zip are filled automatically — there's nothing left for the
  // adjuster to do in them, so focus jumps straight to nextFocusEl (the next field in
  // the form) instead of sitting in the address input or requiring a manual tap past
  // the three fields that just auto-filled.
  function wireAddressAutocomplete(addressInput, { cityInput, stateInput, zipInput, nextFocusEl }) {
    if (!addressInput || !window.google || !google.maps || !google.maps.places) return;

    const autocomplete = new google.maps.places.Autocomplete(addressInput, {
      componentRestrictions: { country: 'us' },
      fields: ['address_components'],
      types: ['address'],
    });

    autocomplete.addListener('place_changed', () => {
      hidePacSuggestions();
      const place = autocomplete.getPlace();
      const comps = place && place.address_components;
      if (!comps) return;

      const get = (type, useShort) => {
        const c = comps.find((cmp) => cmp.types.includes(type));
        return c ? (useShort ? c.short_name : c.long_name) : '';
      };

      const streetNumber = get('street_number');
      const route = get('route');
      const city = get('locality') || get('sublocality') || get('postal_town');
      const state = get('administrative_area_level_1', true);
      const zip = get('postal_code');

      const setVal = (input, value) => {
        if (!input || !value) return;
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };

      setVal(addressInput, [streetNumber, route].filter(Boolean).join(' '));
      setVal(cityInput, city);
      setVal(stateInput, state);
      setVal(zipInput, zip);

      if (nextFocusEl) {
        // Google's pac-container click handler re-focuses the address input itself as
        // part of its own selection cleanup, AFTER place_changed fires — a 0ms timeout
        // loses that race and our focus() gets clobbered a moment later, which is why
        // the jump appeared to silently fail. Blur the address input and push our
        // focus() out past Google's own handling with a longer delay so it wins.
        addressInput.blur();
        setTimeout(() => {
          // If the adjuster is mid voice-dictation chain (e.g. spoke/tapped into the
          // address field and the chain is actively listening), jumpTo stops that
          // session and skips straight past city/state/zip — those are already filled
          // by Google, there's nothing left to dictate into them. Falls back to a plain
          // focus() if the chain isn't engaged, so picking an address while just typing
          // never triggers an unexpected mic prompt.
          const handledByChain = pdfDictationChain && pdfDictationChain.jumpTo(nextFocusEl);
          if (!handledByChain) nextFocusEl.focus();
        }, 150);
      }
    });
  }

  // Wired up via a named global callback because the Google Maps script tag in
  // index.html loads asynchronously — see the <script ... callback=initGoogleAutocomplete>
  // tag there.
  window.initGoogleAutocomplete = function () {
    if (pdfEls.card) pdfEls.card.addEventListener('scroll', hidePacSuggestions);

    wireAddressAutocomplete(pdfEls.addressInput, {
      cityInput: pdfEls.cityInput,
      stateInput: pdfEls.stateInput,
      zipInput: pdfEls.zipInput,
      nextFocusEl: pdfEls.claimInput,
    });

    wireAddressAutocomplete(pdfEls.companyAddressInput, {
      cityInput: pdfEls.companyCityInput,
      stateInput: pdfEls.companyStateInput,
      zipInput: pdfEls.companyZipInput,
      nextFocusEl: pdfEls.contactInput,
    });
  };

  // The address/policy-holder/phone fields live inside a <form> purely so iOS Safari
  // offers its native saved-address/contact autofill suggestions — there's nothing to
  // actually submit, so swallow Enter-key submits rather than letting them reload the page.
  if (pdfEls.infoForm) pdfEls.infoForm.addEventListener('submit', (e) => e.preventDefault());

  pdfEls.perPageOpts.addEventListener('click', (e) => {
    const btn = e.target.closest('.pp-opt');
    if (!btn) return;
    pdfPerPage = Number(btn.dataset.n);
    pdfEls.perPageOpts.querySelectorAll('.pp-opt').forEach((b) => b.classList.toggle('active', b === btn));
  });

  // Defaults the report title to the active property name (until the user edits
  // it themselves), so reports stay matched to the right property without extra steps.
  pdfEls.titleInput.addEventListener('input', () => { pdfTitleAutoFilled = false; });

  // Per-project (per-folder) memory for the claim-specific PDF fields — title, policy
  // holder, claim/policy numbers, property address, owner phone. Unlike loadPdfPrefs()
  // (company/inspector identity, sticky across every project), these are tied to a
  // specific folderId so info entered early — e.g. via "Add PDF Report Info" at project
  // creation, before any photos exist — is still there when the report is actually
  // generated later in the same project.
  const PDF_PROJECT_INFO_KEY = 'pn_pdfProjectInfo';
  function loadPdfProjectInfo(folderId) {
    if (!folderId) return {};
    try {
      const all = JSON.parse(localStorage.getItem(PDF_PROJECT_INFO_KEY) || '{}');
      return all[folderId] || {};
    } catch (e) { return {}; }
  }
  function savePdfProjectInfo(folderId) {
    if (!folderId) return;
    try {
      const all = JSON.parse(localStorage.getItem(PDF_PROJECT_INFO_KEY) || '{}');
      all[folderId] = {
        title: pdfTitleAutoFilled ? '' : pdfEls.titleInput.value.trim(),
        policyHolder: pdfEls.policyInput.value.trim(),
        claimNumber: pdfEls.claimInput.value.trim(),
        policyNumber: pdfEls.policyNumberInput.value.trim(),
        propertyAddress: pdfEls.addressInput.value.trim(),
        propertyCity: pdfEls.cityInput.value.trim(),
        propertyState: pdfEls.stateInput.value.trim(),
        propertyZip: pdfEls.zipInput.value.trim(),
        ownerPhone: pdfEls.ownerPhoneInput.value.trim(),
        narrative: pdfEls.narrativeInput.value.trim(),
      };
      localStorage.setItem(PDF_PROJECT_INFO_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  // Shared by every way the PDF modal can close (Cancel, Save & Start Camera, and
  // Generate) so nothing entered is ever silently lost. savePdfProjectInfo covers the
  // claim-specific fields (tied to this project); the company/inspector identity fields
  // below are sticky across every project, same as Generate has always saved them.
  function saveAllPdfFields() {
    savePdfProjectInfo(currentFolderId);
    savePdfPrefs(Object.assign(loadPdfPrefs(), {
      inspectorName: pdfEls.inspectorInput.value.trim(),
      licenseNumber: pdfEls.licenseInput.value.trim(),
      inspectorPhone: pdfEls.inspectorPhoneInput.value.trim(),
      inspectorEmail: pdfEls.inspectorEmailInput.value.trim(),
      companyName: pdfEls.companyInput.value.trim(),
      companyAddress: pdfEls.companyAddressInput.value.trim(),
      companyCity: pdfEls.companyCityInput.value.trim(),
      companyState: pdfEls.companyStateInput.value.trim(),
      companyZip: pdfEls.companyZipInput.value.trim(),
      companyContact: pdfEls.contactInput.value.trim(),
      logoPosition: pdfLogoPosition,
      logoSizePct:  pdfLogoSizePct,
    }));
  }

  async function saveCompanyProfileToFirestore(prefs) {
    if (!currentFirebaseUser || typeof window.fbSetCompanyProfile !== 'function') return;
    try {
      await window.fbSetCompanyProfile(currentFirebaseUser.uid, prefs);
    } catch (e) { /* Firestore write failed — localStorage copy already saved */ }
  }

  function openPdfModalCore(photoRecords, attachmentRecords) {
    pdfPendingRecords = photoRecords;
    pdfPendingAttachments = attachmentRecords;
    if (pdfTitleAutoFilled) {
      pdfEls.titleInput.value = 'Inspection Photo Report';
    }
    // The narrative is per-report (like the title/claim #), not a sticky preference,
    // so it's cleared each time the modal opens rather than carried over from prefs.
    pdfEls.narrativeInput.value = '';
    const prefs = loadPdfPrefs();
    pdfEls.inspectorInput.value = prefs.inspectorName || '';
    pdfEls.licenseInput.value = prefs.licenseNumber || '';
    pdfEls.inspectorPhoneInput.value = prefs.inspectorPhone || '';
    pdfEls.inspectorEmailInput.value = prefs.inspectorEmail || '';
    pdfEls.companyInput.value = prefs.companyName || '';
    pdfEls.companyAddressInput.value = prefs.companyAddress || '';
    pdfEls.companyCityInput.value = prefs.companyCity || '';
    pdfEls.companyStateInput.value = prefs.companyState || '';
    pdfEls.companyZipInput.value = prefs.companyZip || '';
    pdfEls.contactInput.value = prefs.companyContact || '';
    pdfLogoDataUrl = prefs.logoDataUrl || null;
    pdfLogoPosition = prefs.logoPosition || 'left';
    pdfLogoSizePct  = Number(prefs.logoSizePct) || 100;
    applyLogoPosUI(pdfLogoPosition);
    if (pdfEls.logoSizeSlider) pdfEls.logoSizeSlider.value = pdfLogoSizePct;
    if (pdfEls.logoSizeVal) pdfEls.logoSizeVal.textContent = pdfLogoSizePct;

    // Recall this project's own claim info (if any was entered earlier — e.g. via
    // "Add PDF Report Info" at project creation, before photos existed).
    const projectInfo = loadPdfProjectInfo(currentFolderId);
    if (projectInfo.title) { pdfEls.titleInput.value = projectInfo.title; pdfTitleAutoFilled = false; }
    pdfEls.policyInput.value = projectInfo.policyHolder || '';
    pdfEls.claimInput.value = projectInfo.claimNumber || '';
    pdfEls.policyNumberInput.value = projectInfo.policyNumber || '';
    pdfEls.addressInput.value = projectInfo.propertyAddress || '';
    pdfEls.cityInput.value = projectInfo.propertyCity || '';
    pdfEls.stateInput.value = projectInfo.propertyState || '';
    pdfEls.zipInput.value = projectInfo.propertyZip || '';
    pdfEls.ownerPhoneInput.value = projectInfo.ownerPhone || '';
    pdfEls.narrativeInput.value = projectInfo.narrative || '';

    applyLogoPreview();
    buildCoverPhotoStrip(photoRecords);
    refreshScanSourceOptions();
    setScanStatus('');
    pdfEls.modal.classList.add('active');
  }

  function openPdfOptions(records) {
    if (!records.length) return;
    const photoRecords = records.filter((r) => r.kind !== 'video' && r.kind !== 'pdf'); // report covers photos only
    const attachmentRecords = records.filter((r) => r.kind === 'pdf');
    // A report needs photos and/or attachments to contain anything — but attachments alone
    // (e.g. only a scanned weather/measurement PDF in the gallery, no photos yet) are a valid
    // report on their own: buildPdfReport still produces a cover page and merges the
    // attachment in via pdf-lib even with zero photos. Only block when there's truly nothing.
    if (!photoRecords.length && !attachmentRecords.length) {
      toast('Selected item(s) are video recordings — nothing to add to a photo report');
      return;
    }
    if (pdfEls.saveCamera) pdfEls.saveCamera.classList.add('hidden');
    openPdfModalCore(photoRecords, attachmentRecords);
  }

  // Entry point for "Add Customer Info Now" — opens the same modal with no photos
  // required, so claim/policy/address details can be captured before the inspection
  // is done. Generate is a no-op until photos are added; the fields are saved per-
  // project (see savePdfProjectInfo) so they're still there when the report is
  // actually generated later from the gallery. Swap in the "Save & Start Camera"
  // button in place of Generate, since there's nothing to generate yet — the
  // adjuster's real next step from here is shooting photos, not producing a PDF.
  function openPdfOptionsForProject() {
    if (pdfEls.saveCamera) {
      pdfEls.saveCamera.classList.remove('hidden');
      // "Save & Start Camera" makes no sense on desktop (no camera feed) — relabel it to
      // match what it actually does there (showCamera() on desktop just returns to the
      // dashboard view).
      pdfEls.saveCamera.textContent = isDesktopDevice() ? '💾 Save Info' : '💾 Save & Start Camera';
    }
    openPdfModalCore([], []);
  }

  function closePdfOptions() {
    saveAllPdfFields();
    // Release the mic if a field's dictation was left active (tapped away instead of
    // "confirm and continue") — otherwise it's still tearing down when the camera's
    // photo-naming mic tries to start right after, and iOS silently drops that one.
    if (pdfDictationChain) pdfDictationChain.stop();
    pdfEls.modal.classList.remove('active');
    hidePacSuggestions();
    pdfPendingRecords = null;
    pdfPendingAttachments = null;
    pdfCoverPhotoUrls.forEach((url) => URL.revokeObjectURL(url));
    pdfCoverPhotoUrls = [];
  }

  pdfEls.cancel.addEventListener('click', closePdfOptions);

  if (pdfEls.saveProfileBtn) {
    pdfEls.saveProfileBtn.addEventListener('click', async () => {
      const prefs = {
        companyName: pdfEls.companyInput.value.trim(),
        companyAddress: pdfEls.companyAddressInput.value.trim(),
        companyCity: pdfEls.companyCityInput.value.trim(),
        companyState: pdfEls.companyStateInput.value.trim(),
        companyZip: pdfEls.companyZipInput.value.trim(),
        companyContact: pdfEls.contactInput.value.trim(),
        inspectorName: pdfEls.inspectorInput.value.trim(),
        licenseNumber: pdfEls.licenseInput.value.trim(),
        inspectorPhone: pdfEls.inspectorPhoneInput.value.trim(),
        inspectorEmail: pdfEls.inspectorEmailInput.value.trim(),
        logoDataUrl: pdfLogoDataUrl || null,
      };
      savePdfPrefs(Object.assign(loadPdfPrefs(), prefs));
      await saveCompanyProfileToFirestore(prefs);
      // Brief visual confirmation on the button
      const btn = pdfEls.saveProfileBtn;
      const orig = btn.textContent;
      btn.textContent = '✅ Saved';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
    });
  }

  // Saves whatever's been entered (same persistence as Cancel — closePdfOptions
  // already calls savePdfProjectInfo) and heads straight to the camera, since at
  // this point in the flow there are no photos yet and Generate has nothing to do.
  if (pdfEls.saveCamera) {
    pdfEls.saveCamera.addEventListener('click', () => {
      closePdfOptions();
      showCamera();
    });
  }

  // Clears the rendered preview pages and held blob/opts — called whenever the preview
  // closes, whichever way it closes, so a stale blob/canvas is never reused for a later
  // report.
  function clearPdfPreview() {
    pdfEls.previewFrame.innerHTML = '';
    pdfPreviewBlob = null;
    pdfPreviewOpts = null;
  }

  // Renders every page of the report into the preview container as its own <canvas>,
  // scaled so the entire page fits within the container's current width/height — i.e. no
  // native PDF viewer involved, so there's no dependence on iOS Safari honoring a fit/zoom
  // open-parameter for blob: URLs (it doesn't). Measures the container only after it's
  // already visible (caller adds .active first), since a hidden flex item reports 0 size.
  async function renderPdfPreview(blob) {
    pdfEls.previewFrame.innerHTML = '<div id="pdf-preview-loading">Loading preview…</div>';
    if (!window.pdfjsLib) {
      pdfEls.previewFrame.innerHTML = '<div id="pdf-preview-loading">Preview unavailable — pdf.js failed to load.</div>';
      return;
    }
    const buf = await blob.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const rect = pdfEls.previewFrame.getBoundingClientRect();
    const outputScale = window.devicePixelRatio || 1;
    pdfEls.previewFrame.innerHTML = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      // Scale to fit the container width with a small margin. Pages scroll vertically
      // rather than being forced to full-screen height — this avoids the iOS scroll-snap
      // re-trigger bug that was kicking users out of the preview on pinch-zoom.
      const fitScale = (rect.width - 16) / baseViewport.width;
      const viewport = page.getViewport({ scale: fitScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      const wrap = document.createElement('div');
      wrap.className = 'pdf-preview-page';
      wrap.appendChild(canvas);
      pdfEls.previewFrame.appendChild(wrap);
      const ctx = canvas.getContext('2d');
      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
      await page.render({ canvasContext: ctx, viewport, transform }).promise;
    }
  }

  // Saves the previewed report into this project's gallery (kind:'pdf', same as an attached
  // PDF) and hands it to the OS share sheet. Pulled out of the old Generate handler so both
  // the original flow and the new preview-confirm flow share one save+send path.
  async function saveAndSendPdf(blob, opts) {
    try {
      const now = Date.now();
      await dbAdd({
        id: 'rec_' + now + '_' + Math.random().toString(36).slice(2, 7),
        kind: 'pdf',
        name: opts.title || 'Photo Report',
        blob,
        createdAt: now,
        order: now,
        folderId: currentFolderId,
      });
      refreshGallery();
    } catch (saveErr) {
      console.error(saveErr);
      toast('Report sent, but could not save a copy to the gallery');
    }
    await sharePdf(blob, 'photo-report');
  }

  pdfEls.generate.addEventListener('click', async () => {
    // Same as openPdfOptions: a report can be photos-only, attachments-only, or both — only
    // block when neither is present (this is the customer-info-only entry point, where
    // Generate is hidden in favor of Save & Start Camera/Save Info, so pdfPendingRecords can
    // legitimately be [] there too).
    if ((!pdfPendingRecords || !pdfPendingRecords.length) && (!pdfPendingAttachments || !pdfPendingAttachments.length)) {
      toast('No photos or attachments in this project yet — add some, then come back to generate the report.');
      return;
    }
    const records = pdfPendingRecords || [];
    const inspectorName = pdfEls.inspectorInput.value.trim();
    const licenseNumber = pdfEls.licenseInput.value.trim();
    const inspectorPhone = pdfEls.inspectorPhoneInput.value.trim();
    const inspectorEmail = pdfEls.inspectorEmailInput.value.trim();
    const companyName = pdfEls.companyInput.value.trim();
    const companyAddress = pdfEls.companyAddressInput.value.trim();
    const companyCity = pdfEls.companyCityInput.value.trim();
    const companyState = pdfEls.companyStateInput.value.trim();
    const companyZip = pdfEls.companyZipInput.value.trim();
    const companyContact = pdfEls.contactInput.value.trim();
    const opts = {
      title: pdfEls.titleInput.value.trim() || 'Photo Report',
      policyHolder: pdfEls.policyInput.value.trim(),
      claimNumber: pdfEls.claimInput.value.trim(),
      policyNumber: pdfEls.policyNumberInput.value.trim(),
      propertyAddress: pdfEls.addressInput.value.trim(),
      propertyCity: pdfEls.cityInput.value.trim(),
      propertyState: pdfEls.stateInput.value.trim(),
      propertyZip: pdfEls.zipInput.value.trim(),
      ownerPhone: pdfEls.ownerPhoneInput.value.trim(),
      narrative: pdfEls.narrativeInput.value.trim(),
      perPage: pdfPerPage,
      inspectorName, licenseNumber, inspectorPhone, inspectorEmail,
      companyName, companyAddress, companyCity, companyState, companyZip, companyContact,
      logoDataUrl: pdfLogoDataUrl,
      logoPosition: pdfLogoPosition,
      logoSizePct:  pdfLogoSizePct,
      coverPhotoId: pdfCoverPhotoId,
      attachments: pdfPendingAttachments || [],
    };
    // These cover-page fields are sticky across reports — save whatever's in the
    // fields now so the next report opens pre-filled.
    savePdfPrefs(Object.assign(loadPdfPrefs(), {
      inspectorName, licenseNumber, inspectorPhone, inspectorEmail,
      companyName, companyAddress, companyCity, companyState, companyZip, companyContact,
    }));
    pdfEls.generate.disabled = true;
    pdfEls.generate.textContent = '…';
    try {
      const reportBlob = await buildPdfReport(records, opts);
      // Hold the built report and show it in the preview overlay instead of saving/sharing
      // immediately — catches a wrong field or bad photo order before the report goes out,
      // rather than after. Save & Send (below) reuses this exact blob, so confirming the
      // preview doesn't regenerate or risk drifting from what was actually reviewed.
      pdfPreviewBlob = reportBlob;
      pdfPreviewOpts = opts;
      // Show the overlay first, then render — the container must actually be visible (not
      // display:none) before getBoundingClientRect() inside renderPdfPreview gives a real size.
      pdfEls.previewModal.classList.add('active');
      await renderPdfPreview(reportBlob);
    } catch (err) {
      console.error(err);
      toast('PDF report failed — try again');
    } finally {
      pdfEls.generate.disabled = false;
      pdfEls.generate.textContent = 'Preview';
    }
  });

  // "Back to Edit" — just closes the preview and returns to the still-open options form;
  // nothing has been saved or sent yet, so there's nothing to undo.
  pdfEls.previewBack.addEventListener('click', () => {
    pdfEls.previewModal.classList.remove('active');
    clearPdfPreview();
  });

  // "Save & Send" — confirms the previewed report is correct, then runs the same
  // save-to-gallery + share-sheet flow the old Generate button used to run immediately.
  pdfEls.previewSend.addEventListener('click', async () => {
    if (!pdfPreviewBlob || !pdfPreviewOpts) return;
    const blob = pdfPreviewBlob;
    const opts = pdfPreviewOpts;
    pdfEls.previewSend.disabled = true;
    pdfEls.previewSend.textContent = '…';
    try {
      pdfEls.previewModal.classList.remove('active');
      clearPdfPreview();
      closePdfOptions();
      await saveAndSendPdf(blob, opts);
    } catch (err) {
      console.error(err);
      toast('PDF report failed — try again');
    } finally {
      pdfEls.previewSend.disabled = false;
      pdfEls.previewSend.textContent = 'Save & Send';
    }
  });

  els.pdfAllBtn.addEventListener('click', async () => {
    const records = await getFolderPhotos(currentFolderId);
    openPdfOptions(records);
  });

  els.bulkPdf.addEventListener('click', async () => {
    const allRecords = await dbGetAll();
    const byId = new Map(allRecords.map((r) => [r.id, r]));
    const records = galleryIds.filter((id) => selectedIds.has(id)).map((id) => byId.get(id)).filter(Boolean);
    openPdfOptions(records);
  });

  // Sends exactly the selected photos/videos via the share sheet — no zip, no "export
  // all" — so picking one recording and tapping Send only sends that one recording.
  els.bulkShare.addEventListener('click', async () => {
    const allRecords = await dbGetAll();
    const byId = new Map(allRecords.map((r) => [r.id, r]));
    const records = galleryIds.filter((id) => selectedIds.has(id)).map((id) => byId.get(id)).filter(Boolean);
    if (!records.length) return;
    const usedNames = new Map();
    const files = records.map((rec) => {
      const isVideo = rec.kind === 'video';
      const isPdf = rec.kind === 'pdf';
      const mimeType = rec.blob.type || (isVideo ? 'video/mp4' : isPdf ? 'application/pdf' : 'image/jpeg');
      const ext = isVideo ? (mimeType.includes('mp4') ? 'mp4' : 'webm') : isPdf ? 'pdf' : 'jpg';
      let base = sanitizeFilename(rec.name);
      const count = usedNames.get(base) || 0;
      usedNames.set(base, count + 1);
      const filename = count === 0 ? `${base}.${ext}` : `${base}_${count + 1}.${ext}`;
      return new File([rec.blob], filename, { type: mimeType });
    });
    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files, title: records.length === 1 ? records[0].name : `${records.length} items` });
      } catch (e) { /* user cancelled — nothing to do */ }
    } else {
      toast('Sharing files isn’t supported in this browser');
    }
  });

  /* ---------------- Bulk Download ---------------- */
  // Downloads selected photos/files to the computer.
  // - 1 file: downloads directly with a descriptive filename.
  // - 2+ files: bundles into a ZIP (JSZip is already loaded for Export All).
  // Filename includes category + sublocation + building + voice label so files
  // are self-describing on disk without needing to open them.
  function buildDownloadFilename(rec, usedNames) {
    const parts = [];
    if (rec.category && ['exterior', 'roof', 'interior'].includes(rec.category)) {
      parts.push(rec.category === 'exterior' ? 'Exterior' : rec.category === 'roof' ? 'Roof' : 'Interior');
      if (rec.subLocation) parts.push(rec.subLocation);
    }
    if (rec.building) parts.push(rec.building);
    parts.push(rec.name || 'Photo');
    const base = sanitizeFilename(parts.join(' - '));
    const ext = rec.kind === 'pdf' ? 'pdf' : rec.kind === 'video' ? (rec.blob.type.includes('mp4') ? 'mp4' : 'webm') : 'jpg';
    const count = usedNames.get(base) || 0;
    usedNames.set(base, count + 1);
    return count === 0 ? `${base}.${ext}` : `${base}_${count + 1}.${ext}`;
  }

  els.bulkDownload.addEventListener('click', async () => {
    if (!selectedIds.size) return;
    const allRecords = await dbGetAll();
    const selected = allRecords.filter((r) => selectedIds.has(r.id));
    if (!selected.length) return;
    const usedNames = new Map();

    if (selected.length === 1) {
      // Single file — download directly
      const rec = selected[0];
      const filename = buildDownloadFilename(rec, usedNames);
      const url = URL.createObjectURL(rec.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else {
      // Multiple files — bundle into a ZIP
      const origText = els.bulkDownload.textContent;
      els.bulkDownload.disabled = true;
      els.bulkDownload.textContent = 'Zipping…';
      try {
        const zip = new JSZip();
        for (const rec of selected) {
          zip.file(buildDownloadFilename(rec, usedNames), rec.blob);
        }
        const content = await zip.generateAsync({ type: 'blob' });
        const stamp = new Date().toISOString().slice(0, 10);
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        const projectPart = currentFolderName ? sanitizeFilename(currentFolderName) : 'photos';
        a.download = `${projectPart}-${stamp}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) {
        toast('Download failed — try again');
      } finally {
        els.bulkDownload.disabled = false;
        els.bulkDownload.textContent = origText;
      }
    }
  });

  /* ---------------- Exit button ---------------- */
  function handleExitApp() {
    if (confirm('Exit to the Name That Photo home page?')) {
      stopCamera();
      window.location.href = '/';
    }
  }
  const exitBtn = document.getElementById('exit-app');
  if (exitBtn) exitBtn.addEventListener('click', handleExitApp);
  const camExitBtn = document.getElementById('cam-exit-app');
  if (camExitBtn) camExitBtn.addEventListener('click', handleExitApp);

  /* ---------------- Service worker ---------------- */
  // updateViaCache:'none' tells the browser to always fetch sw.js itself straight from the
  // network (never from HTTP cache) when checking for updates. Without this, a browser can
  // keep serving a stale cached copy of sw.js for a long time — which is exactly what
  // happened in Edge: it sat on the very first deployed cache version (v1) through many
  // later deploys because it never re-fetched sw.js to notice the CACHE constant had changed.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
      navigator.serviceWorker.getRegistration().then((reg) => reg && reg.update().catch(() => {}));
    });
  }

  /* ---------------- Auth (sign in / sign up) ----------------
     Firebase Auth/Firestore SDK calls live in a <script type="module"> in index.html
     (this file is a classic script and can't use `import`); that script funnels every
     call through window.fb*() functions and fires a "fb-auth-changed" window event
     whenever sign-in state changes. currentUserDoc is the Firestore users/{uid} record —
     it's not used for access gating yet (task #64, blocked on Stripe/webhook setup); for
     now, any successfully authenticated user reaches the app. */
  let authMode = 'signin';
  let currentFirebaseUser = null;
  let currentUserDoc = null;
  let unsubUserDoc = null; // Firestore real-time listener unsubscribe — see fb-auth-changed handler
  let appStarted = false;

  function showAuthError(msg) {
    els.authError.textContent = msg;
    els.authError.classList.remove('hidden');
  }
  function clearAuthError() {
    els.authError.classList.add('hidden');
    els.authError.textContent = '';
  }
  function renderAuthMode() {
    if (authMode === 'signin') {
      els.authSubtitle.textContent = 'Sign in to continue';
      els.authSubmit.textContent = 'Sign In';
      els.authToggleMode.textContent = 'Need an account? Sign up';
    } else {
      els.authSubtitle.textContent = 'Create your account';
      els.authSubmit.textContent = 'Sign Up';
      els.authToggleMode.textContent = 'Already have an account? Sign in';
    }
  }
  function friendlyAuthError(err) {
    switch (err && err.code) {
      case 'auth/invalid-email': return 'Enter a valid email address.';
      case 'auth/missing-password':
      case 'auth/weak-password': return 'Password must be at least 6 characters.';
      case 'auth/email-already-in-use': return 'An account already exists for that email — sign in instead.';
      case 'auth/invalid-credential':
      case 'auth/wrong-password': return 'Incorrect email or password.';
      case 'auth/user-not-found': return 'No account found for that email.';
      case 'auth/too-many-requests': return 'Too many attempts — wait a moment and try again.';
      default: return (err && err.message) || 'Something went wrong. Try again.';
    }
  }
  // Desktop/laptop sessions are review-only: an inspector takes photos on their phone
  // and only opens the desktop app later to name/label them and assemble reports — there's
  // no reason to request the webcam on launch there. No touch points + no mobile/tablet
  // user-agent string is treated as "desktop." The Camera tab itself still works if tapped
  // manually (e.g. a webcam-equipped laptop); this only controls what loads on startup.
  function isDesktopDevice() {
    const ua = navigator.userAgent;
    if (/Mobi|Android|iPhone|iPod|iPad/i.test(ua)) return false; // phones/tablets always get the camera
    // A real Windows/Linux/ChromeOS PC is a desktop even if it has a touchscreen — only
    // iPadOS Safari needs the touch-point check, since it reports a plain "Macintosh" UA
    // identical to a real Mac's and is only distinguishable by maxTouchPoints > 1.
    if (/Windows|Linux|CrOS|X11/i.test(ua)) return true;
    return navigator.maxTouchPoints <= 1;
  }

  function startAppUI() {
    if (appStarted) return;
    appStarted = true;
    if (isDesktopDevice()) {
      // Backup-to-Phone only makes sense on an actual phone (it shares files into
      // the iOS Photos app via the share sheet) — hide it on desktop sessions.
      if (els.backupBtn) els.backupBtn.style.display = 'none';
    }
    showCamera();
    refreshGallery();
  }

  if (els.authToggleMode) {
    els.authToggleMode.addEventListener('click', () => {
      authMode = authMode === 'signin' ? 'signup' : 'signin';
      clearAuthError();
      renderAuthMode();
    });
  }
  if (els.authSubmit) {
    els.authSubmit.addEventListener('click', async () => {
      const email = els.authEmail.value.trim();
      const password = els.authPassword.value;
      if (!email || !password) { showAuthError('Enter both email and password.'); return; }
      clearAuthError();
      els.authSubmit.disabled = true;
      const origText = els.authSubmit.textContent;
      els.authSubmit.textContent = authMode === 'signin' ? 'Signing in…' : 'Creating account…';
      try {
        if (authMode === 'signin') {
          await window.fbSignIn(email, password);
        } else {
          await window.fbSignUp(email, password);
        }
        // The "fb-auth-changed" listener below takes it from here once Firebase fires.
      } catch (err) {
        showAuthError(friendlyAuthError(err));
      } finally {
        els.authSubmit.disabled = false;
        els.authSubmit.textContent = origText;
      }
    });
  }
  if (els.authPassword) {
    els.authPassword.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') els.authSubmit.click();
    });
  }
  if (els.authForgot) {
    els.authForgot.addEventListener('click', async () => {
      const email = els.authEmail.value.trim();
      if (!email) {
        showAuthError('Enter your email address above first, then tap "Forgot password?" again.');
        els.authEmail.focus();
        return;
      }
      if (typeof window.fbResetPassword !== 'function') {
        showAuthError('Still loading — wait a moment and try again.');
        return;
      }
      clearAuthError();
      els.authForgot.disabled = true;
      els.authForgot.textContent = 'Sending…';
      try {
        await window.fbResetPassword(email);
        showAuthError(`Reset email sent to ${email}. Check your inbox (and spam folder).`);
        els.authError.style.color = '#30d158'; // green
      } catch (err) {
        els.authError.style.color = '';
        showAuthError(friendlyAuthError(err));
      } finally {
        els.authForgot.disabled = false;
        els.authForgot.textContent = 'Forgot password?';
      }
    });
  }
  renderAuthMode();

  /* ---------------- Paywall (Stripe Checkout) ----------------
     Subscription state lives in Firestore users/{uid}.status, written ONLY by the Stripe
     webhook (task #63) — never by this client — per the server-side-only enforcement
     principle (client-side gating alone is bypassable via dev tools). betaAccess is a
     separate manual override for power-user testers, toggled from the admin screen
     (task #65), also server-written only. Until #63/#65 exist, every new signup stays on
     this paywall until Stripe Checkout completes AND the webhook flips status — so right
     now, completing test-mode checkout will NOT yet unlock the app; that's expected until
     the webhook is built. */
  const CHECKOUT_FUNCTION_URL = 'https://dapper-hummingbird-736d0d.netlify.app/.netlify/functions/create-checkout-session';

  function hasAccess(userDoc) {
    if (!userDoc) return false;
    if (userDoc.betaAccess) return true;
    return userDoc.status === 'trial' || userDoc.status === 'active';
  }
  function showAuthScreen() {
    els.appRoot.classList.add('hidden');
    els.paywallView.classList.add('hidden');
    els.authView.classList.remove('hidden');
  }
  function showPaywallScreen() {
    els.appRoot.classList.add('hidden');
    els.authView.classList.add('hidden');
    els.paywallView.classList.remove('hidden');
  }
  function showAppScreen() {
    els.authView.classList.add('hidden');
    els.paywallView.classList.add('hidden');
    els.appRoot.classList.remove('hidden');
    startAppUI();
  }
  function showPaywallError(msg) {
    els.paywallError.textContent = msg;
    els.paywallError.classList.remove('hidden');
  }
  function clearPaywallError() {
    els.paywallError.classList.add('hidden');
    els.paywallError.textContent = '';
  }

  if (els.paywallStart) {
    els.paywallStart.addEventListener('click', async () => {
      if (!currentFirebaseUser) return;
      clearPaywallError();
      els.paywallStart.disabled = true;
      const origText = els.paywallStart.textContent;
      els.paywallStart.textContent = 'Loading…';
      try {
        const res = await fetch(CHECKOUT_FUNCTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: currentFirebaseUser.uid, email: currentFirebaseUser.email }),
        });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || 'Could not start checkout');
        window.location.href = data.url; // hand off to Stripe Checkout
      } catch (err) {
        showPaywallError(err.message || 'Could not start checkout. Try again.');
        els.paywallStart.disabled = false;
        els.paywallStart.textContent = origText;
      }
    });
  }
  if (els.paywallRefresh) {
    els.paywallRefresh.addEventListener('click', async () => {
      if (!currentFirebaseUser) return;
      clearPaywallError();
      els.paywallRefresh.textContent = 'Checking…';
      try {
        currentUserDoc = await window.fbGetUserDoc(currentFirebaseUser.uid);
        if (hasAccess(currentUserDoc)) {
          showAppScreen();
        } else {
          showPaywallError('Still showing no active subscription. If you just paid, wait a moment and try again.');
        }
      } catch (err) {
        showPaywallError('Could not check status. Try again.');
      } finally {
        els.paywallRefresh.textContent = 'I already paid — refresh status';
      }
    });
  }
  if (els.paywallSignout) {
    els.paywallSignout.addEventListener('click', () => window.fbSignOut());
  }

  /* ---------------- Admin (hidden beta-access toggle, task #65) ----------------
     Reached only by visiting ?admin=1 while signed in as one of CLIENT_ADMIN_EMAILS — this
     list is just so the screen doesn't show up for regular users; it is NOT the security
     boundary. The actual enforcement is server-side in admin-set-beta.js, which independently
     re-verifies the caller's Firebase ID token against its own ADMIN_EMAILS allowlist on
     Netlify, so this client-side list being visible in page source grants nothing on its own. */
  const CLIENT_ADMIN_EMAILS = ['namethatphoto@gmail.com'];
  const ADMIN_FUNCTION_URL = 'https://dapper-hummingbird-736d0d.netlify.app/.netlify/functions/admin-set-beta';

  function showAdminStatus(msg, isError) {
    els.adminStatus.textContent = msg;
    els.adminStatus.classList.remove('hidden', 'error', 'success');
    els.adminStatus.classList.add(isError ? 'error' : 'success');
  }
  function clearAdminStatus() {
    els.adminStatus.classList.add('hidden');
    els.adminStatus.textContent = '';
  }
  function showAdminScreen() {
    clearAdminStatus();
    els.adminEmail.value = '';
    els.adminBetaToggle.checked = false;
    els.adminView.classList.remove('hidden');
  }
  function hideAdminScreen() {
    els.adminView.classList.add('hidden');
  }

  if (els.adminSave) {
    els.adminSave.addEventListener('click', async () => {
      const targetEmail = els.adminEmail.value.trim();
      if (!targetEmail) { showAdminStatus('Enter a user email.', true); return; }
      clearAdminStatus();
      els.adminSave.disabled = true;
      const origText = els.adminSave.textContent;
      els.adminSave.textContent = 'Saving…';
      try {
        const idToken = await window.fbGetIdToken();
        if (!idToken) throw new Error('Not signed in.');
        const res = await fetch(ADMIN_FUNCTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, targetEmail, betaAccess: els.adminBetaToggle.checked }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not save.');
        showAdminStatus(`Beta access ${data.betaAccess ? 'granted' : 'removed'} for ${targetEmail}.`, false);
      } catch (err) {
        showAdminStatus(err.message || 'Could not save. Try again.', true);
      } finally {
        els.adminSave.disabled = false;
        els.adminSave.textContent = origText;
      }
    });
  }
  if (els.adminClose) {
    els.adminClose.addEventListener('click', hideAdminScreen);
  }

  /* ---------------- Account screen (Billing Portal, task #66) ----------------
     Lets a subscriber cancel or update their card themselves instead of emailing support.
     Does NOT send a Stripe customer ID from this client — create-portal-session.js looks up
     the caller's own stripeCustomerId server-side from their verified uid, so this can't be
     used to open someone else's billing portal by tampering with the request. */
  const PORTAL_FUNCTION_URL = 'https://dapper-hummingbird-736d0d.netlify.app/.netlify/functions/create-portal-session';

  function showAccountError(msg) {
    els.accountError.textContent = msg;
    els.accountError.classList.remove('hidden');
  }
  function clearAccountError() {
    els.accountError.classList.add('hidden');
    els.accountError.textContent = '';
  }
  function renderAccountStatus() {
    if (!currentUserDoc) { els.accountStatusText.textContent = ''; return; }
    if (currentUserDoc.betaAccess) {
      els.accountStatusText.textContent = 'Beta access — no subscription required.';
      els.accountManage.classList.add('hidden');
    } else if (currentUserDoc.status === 'trial') {
      els.accountStatusText.textContent = 'Free trial active.';
      els.accountManage.classList.remove('hidden');
    } else if (currentUserDoc.status === 'active') {
      els.accountStatusText.textContent = 'Subscription active — $17.99/month.';
      els.accountManage.classList.remove('hidden');
    } else if (currentUserDoc.status === 'canceled') {
      els.accountStatusText.textContent = 'Subscription canceled.';
      els.accountManage.classList.add('hidden');
    } else {
      els.accountStatusText.textContent = currentUserDoc.status || 'Unknown status.';
      els.accountManage.classList.remove('hidden');
    }
  }
  /* ================================================================
     SETTINGS MODAL
     ================================================================ */
  let stgLogoDataUrl = null;

  function updateStgDriveStatusUI() {
    if (!els.stgDriveStatusText) return;
    const connected = !!driveAccessToken || localStorage.getItem(DRIVE_CONNECTED_KEY) === '1';
    els.stgDriveStatusText.textContent = connected ? 'Google Drive: Connected ✓' : 'Google Drive: Not connected';
    if (els.stgDriveConnectBtn) els.stgDriveConnectBtn.classList.toggle('hidden', connected);
    if (els.stgDriveDisconnectBtn) els.stgDriveDisconnectBtn.classList.toggle('hidden', !connected);
  }

  function applyStgLogoPreview() {
    if (!els.stgLogoPreview || !els.stgLogoPreviewImg) return;
    if (stgLogoDataUrl) {
      els.stgLogoPreviewImg.src = stgLogoDataUrl;
      els.stgLogoPreview.classList.remove('hidden');
    } else {
      els.stgLogoPreview.classList.add('hidden');
      els.stgLogoPreviewImg.src = '';
    }
  }

  function openSettingsModal() {
    const prefs = loadPdfPrefs();
    if (els.stgCompanyInput) els.stgCompanyInput.value = prefs.companyName || '';
    if (els.stgCompanyAddressInput) els.stgCompanyAddressInput.value = prefs.companyAddress || '';
    if (els.stgCompanyCityInput) els.stgCompanyCityInput.value = prefs.companyCity || '';
    if (els.stgCompanyStateInput) els.stgCompanyStateInput.value = prefs.companyState || '';
    if (els.stgCompanyZipInput) els.stgCompanyZipInput.value = prefs.companyZip || '';
    if (els.stgContactInput) els.stgContactInput.value = prefs.companyContact || '';
    if (els.stgInspectorInput) els.stgInspectorInput.value = prefs.inspectorName || '';
    if (els.stgLicenseInput) els.stgLicenseInput.value = prefs.licenseNumber || '';
    if (els.stgInspectorPhoneInput) els.stgInspectorPhoneInput.value = prefs.inspectorPhone || '';
    if (els.stgInspectorEmailInput) els.stgInspectorEmailInput.value = prefs.inspectorEmail || '';
    stgLogoDataUrl = prefs.logoDataUrl || null;
    applyStgLogoPreview();
    updateStgDriveStatusUI();
    els.settingsModal.classList.remove('hidden');
  }

  function closeSettingsModal() {
    if (els.settingsModal) els.settingsModal.classList.add('hidden');
  }

  if (els.settingsBtn) els.settingsBtn.addEventListener('click', () => openSettingsModal());
  if (els.settingsClose) els.settingsClose.addEventListener('click', closeSettingsModal);

  if (els.stgLogoPick) {
    els.stgLogoPick.addEventListener('click', () => { if (els.stgLogoFile) els.stgLogoFile.click(); });
  }
  if (els.stgLogoFile) {
    els.stgLogoFile.addEventListener('change', () => {
      const f = els.stgLogoFile.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = (ev) => { stgLogoDataUrl = ev.target.result; applyStgLogoPreview(); };
      reader.readAsDataURL(f);
    });
  }
  if (els.stgLogoClear) {
    els.stgLogoClear.addEventListener('click', () => { stgLogoDataUrl = null; applyStgLogoPreview(); });
  }

  if (els.stgSaveProfileBtn) {
    els.stgSaveProfileBtn.addEventListener('click', async () => {
      const prefs = {
        companyName: els.stgCompanyInput.value.trim(),
        companyAddress: els.stgCompanyAddressInput.value.trim(),
        companyCity: els.stgCompanyCityInput.value.trim(),
        companyState: els.stgCompanyStateInput.value.trim(),
        companyZip: els.stgCompanyZipInput.value.trim(),
        companyContact: els.stgContactInput.value.trim(),
        inspectorName: els.stgInspectorInput.value.trim(),
        licenseNumber: els.stgLicenseInput.value.trim(),
        inspectorPhone: els.stgInspectorPhoneInput.value.trim(),
        inspectorEmail: els.stgInspectorEmailInput.value.trim(),
        logoDataUrl: stgLogoDataUrl || null,
      };
      savePdfPrefs(Object.assign(loadPdfPrefs(), prefs));
      await saveCompanyProfileToFirestore(prefs);
      const btn = els.stgSaveProfileBtn;
      const orig = btn.textContent;
      btn.textContent = '✅ Saved';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
    });
  }

  if (els.stgDriveConnectBtn) {
    els.stgDriveConnectBtn.addEventListener('click', async () => {
      const token = await getDriveAccessToken({ interactive: true });
      updateDriveStatusUI();
      updateStgDriveStatusUI();
      if (!token) toast('Google Drive sign-in was cancelled or failed');
    });
  }
  if (els.stgDriveDisconnectBtn) {
    els.stgDriveDisconnectBtn.addEventListener('click', () => { disconnectDrive(); updateStgDriveStatusUI(); });
  }

  /* ================================================================
     SETUP WIZARD (first-run onboarding)
     ================================================================ */
  let setupLogoDataUrl = null;

  function applySetupLogoPreview() {
    if (!els.setupLogoPreview || !els.setupLogoPreviewImg) return;
    if (setupLogoDataUrl) {
      els.setupLogoPreviewImg.src = setupLogoDataUrl;
      els.setupLogoPreview.classList.remove('hidden');
    } else {
      els.setupLogoPreview.classList.add('hidden');
      els.setupLogoPreviewImg.src = '';
    }
  }

  if (els.setupLogoPick) els.setupLogoPick.addEventListener('click', () => els.setupLogoFile?.click());
  if (els.setupLogoFile) {
    els.setupLogoFile.addEventListener('change', () => {
      const f = els.setupLogoFile.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = (ev) => { setupLogoDataUrl = ev.target.result; applySetupLogoPreview(); };
      reader.readAsDataURL(f);
    });
  }
  if (els.setupLogoClear) {
    els.setupLogoClear.addEventListener('click', () => { setupLogoDataUrl = null; applySetupLogoPreview(); });
  }

  function updateSetupDriveStatusUI() {
    if (!els.setupDriveStatusText) return;
    const connected = !!driveAccessToken || localStorage.getItem(DRIVE_CONNECTED_KEY) === '1';
    els.setupDriveStatusText.textContent = connected ? 'Google Drive: Connected ✓' : 'Google Drive: Not connected';
    if (els.setupDriveConnectBtn) els.setupDriveConnectBtn.classList.toggle('hidden', connected);
    if (els.setupDriveDisconnectBtn) els.setupDriveDisconnectBtn.classList.toggle('hidden', !connected);
  }

  function showSetupWizard() {
    if (!els.setupWizard) return;
    // Step 1: pre-fill any existing prefs (e.g. returning user who cleared cache)
    const prefs = loadPdfPrefs();
    if (els.setupCompanyInput) els.setupCompanyInput.value = prefs.companyName || '';
    if (els.setupCompanyAddressInput) els.setupCompanyAddressInput.value = prefs.companyAddress || '';
    if (els.setupCompanyCityInput) els.setupCompanyCityInput.value = prefs.companyCity || '';
    if (els.setupCompanyStateInput) els.setupCompanyStateInput.value = prefs.companyState || '';
    if (els.setupCompanyZipInput) els.setupCompanyZipInput.value = prefs.companyZip || '';
    if (els.setupContactInput) els.setupContactInput.value = prefs.companyContact || '';
    setupLogoDataUrl = prefs.logoDataUrl || null;
    applySetupLogoPreview();
    if (els.setupInspectorInput) els.setupInspectorInput.value = prefs.inspectorName || '';
    if (els.setupLicenseInput) els.setupLicenseInput.value = prefs.licenseNumber || '';
    if (els.setupInspectorPhoneInput) els.setupInspectorPhoneInput.value = prefs.inspectorPhone || '';
    if (els.setupInspectorEmailInput) els.setupInspectorEmailInput.value = prefs.inspectorEmail || '';
    // Show step 1
    if (els.setupStep1) els.setupStep1.classList.remove('hidden');
    if (els.setupStep2) els.setupStep2.classList.add('hidden');
    if (els.setupStepNum) els.setupStepNum.textContent = '1';
    els.setupWizard.classList.remove('hidden');
  }

  async function completeSetup() {
    if (!els.setupWizard) return;
    els.setupWizard.classList.add('hidden');
    // Mark setup complete in Firestore so the wizard never shows again
    if (currentFirebaseUser && typeof window.fbUpdateUserDoc === 'function') {
      try { await window.fbUpdateUserDoc(currentFirebaseUser.uid, { setupComplete: true }); } catch (e) {}
    }
    // Also persist locally so it's instant on next load
    if (currentFirebaseUser) localStorage.setItem('pn_setupDone_' + currentFirebaseUser.uid, '1');
  }

  if (els.setupNextBtn) {
    els.setupNextBtn.addEventListener('click', async () => {
      // Save Step 1 company/inspector prefs
      const prefs = {
        companyName: (els.setupCompanyInput?.value || '').trim(),
        companyAddress: (els.setupCompanyAddressInput?.value || '').trim(),
        companyCity: (els.setupCompanyCityInput?.value || '').trim(),
        companyState: (els.setupCompanyStateInput?.value || '').trim(),
        companyZip: (els.setupCompanyZipInput?.value || '').trim(),
        companyContact: (els.setupContactInput?.value || '').trim(),
        inspectorName: (els.setupInspectorInput?.value || '').trim(),
        licenseNumber: (els.setupLicenseInput?.value || '').trim(),
        inspectorPhone: (els.setupInspectorPhoneInput?.value || '').trim(),
        inspectorEmail: (els.setupInspectorEmailInput?.value || '').trim(),
        logoDataUrl: setupLogoDataUrl || null,
      };
      savePdfPrefs(Object.assign(loadPdfPrefs(), prefs));
      saveCompanyProfileToFirestore(prefs); // async, no need to await
      // Advance to step 2
      if (els.setupStep1) els.setupStep1.classList.add('hidden');
      if (els.setupStep2) els.setupStep2.classList.remove('hidden');
      if (els.setupStepNum) els.setupStepNum.textContent = '2';
      updateSetupDriveStatusUI();
    });
  }

  if (els.setupDriveConnectBtn) {
    els.setupDriveConnectBtn.addEventListener('click', async () => {
      const token = await getDriveAccessToken({ interactive: true });
      updateDriveStatusUI();
      updateSetupDriveStatusUI();
      if (!token) toast('Google Drive sign-in was cancelled or failed');
    });
  }
  if (els.setupDriveDisconnectBtn) {
    els.setupDriveDisconnectBtn.addEventListener('click', () => {
      disconnectDrive();
      updateSetupDriveStatusUI();
    });
  }

  if (els.setupFinishBtn) els.setupFinishBtn.addEventListener('click', completeSetup);
  if (els.setupSkipDrive) els.setupSkipDrive.addEventListener('click', completeSetup);

  function showAccountScreen() {
    clearAccountError();
    renderAccountStatus();
    els.accountView.classList.remove('hidden');
  }
  function hideAccountScreen() {
    els.accountView.classList.add('hidden');
  }

  if (els.accountBtn) {
    els.accountBtn.addEventListener('click', showAccountScreen);
  }
  if (els.accountClose) {
    els.accountClose.addEventListener('click', hideAccountScreen);
  }
  if (els.accountSignoutBtn) {
    els.accountSignoutBtn.addEventListener('click', () => window.fbSignOut());
  }
  if (els.accountManage) {
    els.accountManage.addEventListener('click', async () => {
      clearAccountError();
      els.accountManage.disabled = true;
      const origText = els.accountManage.textContent;
      els.accountManage.textContent = 'Loading…';
      try {
        const idToken = await window.fbGetIdToken();
        if (!idToken) throw new Error('Not signed in.');
        const res = await fetch(PORTAL_FUNCTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || 'Could not open billing portal.');
        window.location.href = data.url; // hand off to Stripe's hosted Billing Portal
      } catch (err) {
        showAccountError(err.message || 'Could not open billing portal. Try again.');
        els.accountManage.disabled = false;
        els.accountManage.textContent = origText;
      }
    });
  }

  // Returning from Stripe Checkout — surface a clear status message either way.
  (function handleCheckoutReturn() {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    if (checkout === 'success') {
      toast('Payment received — finishing setup…');
    } else if (checkout === 'cancel') {
      toast('Checkout canceled');
    }
    if (checkout) {
      params.delete('checkout');
      params.delete('session_id');
      const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
      window.history.replaceState({}, '', clean);
    }
  })();

  window.addEventListener('fb-auth-changed', async (e) => {
    const user = e.detail.user;
    currentFirebaseUser = user;
    // Tear down any existing Firestore listener from a previous session
    if (unsubUserDoc) { unsubUserDoc(); unsubUserDoc = null; }
    if (user) {
      try {
        currentUserDoc = await window.fbGetUserDoc(user.uid);
      } catch (err) {
        currentUserDoc = null; // Firestore read failed (e.g. rules not yet published) — don't block sign-in on it
      }
      // Load cloud-saved company/inspector profile and merge into localStorage so PDF
      // fields populate correctly even after the browser cache has been cleared.
      if (typeof window.fbGetCompanyProfile === 'function') {
        try {
          const cloudProfile = await window.fbGetCompanyProfile(user.uid);
          if (cloudProfile) savePdfPrefs(Object.assign(loadPdfPrefs(), cloudProfile));
        } catch (e) { /* ignore — localStorage values serve as fallback */ }
      }
      els.authEmail.value = '';
      els.authPassword.value = '';
      if (hasAccess(currentUserDoc)) {
        showAppScreen();
        // Show setup wizard on first sign-in (no setupComplete flag AND no local override)
        const localDone = localStorage.getItem('pn_setupDone_' + user.uid) === '1';
        if (!currentUserDoc?.setupComplete && !localDone) {
          showSetupWizard();
        }
      } else {
        showPaywallScreen();
      }
      const wantsAdmin = new URLSearchParams(window.location.search).get('admin') === '1';
      if (wantsAdmin && user.email && CLIENT_ADMIN_EMAILS.includes(user.email.toLowerCase())) {
        showAdminScreen();
      }
      // Real-time listener — detects admin-side betaAccess revocation without requiring sign-out.
      // Fires immediately with current doc (no-op since we just fetched it), then again on changes.
      if (typeof window.fbListenUserDoc === 'function') {
        unsubUserDoc = window.fbListenUserDoc(user.uid, (updatedDoc) => {
          currentUserDoc = updatedDoc;
          if (!hasAccess(updatedDoc)) showPaywallScreen();
        });
      }
    } else {
      currentUserDoc = null;
      showAuthScreen();
    }
  });

  /* ---------------- Init ---------------- */
  (async function init() {
    db = await openDB();
    await bootstrapFolders();
    // showCamera()/refreshGallery() are deferred to startAppUI(), triggered by the
    // "fb-auth-changed" listener above once the user is signed in.
  })();
})();
