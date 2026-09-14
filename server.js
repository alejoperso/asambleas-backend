<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Asamblea Virtual | Propiedad Horizontal</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-gray-900 text-gray-100 flex flex-col h-screen font-sans overflow-hidden">

  <!-- BARRA TRANSPARENTE DE IDENTIFICACIÓN Y SEGURIDAD (HEADER) -->
  <header class="bg-gray-800/90 backdrop-blur-md border-b border-gray-700 px-4 py-3 flex items-center justify-between z-10 shadow-lg">
    <div class="flex items-center space-x-3">
      <img id="logo-copropiedad" src="https://via.placeholder.com/150x40?text=Copropiedad" alt="Logo" class="h-9 object-contain bg-white/10 rounded px-2">
      <h1 id="nombre-copropiedad" class="text-sm md:text-base font-bold text-white tracking-wide">Asamblea General de Copropietarios</h1>
    </div>

    <!-- DATOS DE TRANSPARENCIA EN TIEMPO REAL -->
    <div id="user-bar" class="hidden md:flex items-center space-x-6 text-xs md:text-sm bg-gray-900/60 px-4 py-1.5 rounded-full border border-gray-700">
      <div><span class="text-gray-400">ID:</span> <strong id="bar-user-id" class="text-indigo-400">---</strong></div>
      <div><span class="text-gray-400">Nombre:</span> <strong id="bar-user-name" class="text-white">---</strong></div>
      <div><span class="text-gray-400">Unidad:</span> <strong id="bar-user-unit" class="text-emerald-400">---</strong></div>
      <div><span class="text-gray-400">Coeficiente:</span> <strong id="bar-user-coef" class="text-yellow-400">0.0000%</strong></div>
    </div>

    <div class="flex items-center space-x-3">
      <span id="quorum-badge" class="bg-emerald-900/80 text-emerald-300 text-xs px-3 py-1.5 rounded-full font-semibold border border-emerald-700">
        Quórum: <span id="quorum-val">0.00%</span>
      </span>
      <button id="btn-logout" onclick="logout()" class="hidden text-xs bg-red-600/80 hover:bg-red-600 text-white px-3 py-1.5 rounded transition" title="Cerrar Sesión">
        <i class="fa-solid fa-right-from-bracket"></i>
      </button>
    </div>
  </header>

  <!-- MODAL DE AUTENTICACIÓN / INGRESO -->
  <div id="login-modal" class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
    <div class="bg-gray-800 border border-gray-700 rounded-xl p-6 md:p-8 max-w-md w-full shadow-2xl">
      <div class="text-center mb-6">
        <i class="fa-solid fa-building-user text-4xl text-indigo-500 mb-2"></i>
        <h2 class="text-xl font-bold text-white">Ingreso a la Asamblea</h2>
        <p class="text-xs text-gray-400 mt-1">Digita tu Identificador Único asignado</p>
      </div>
      <form id="form-login" onsubmit="iniciarSesion(event)" class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Identificador Único (ID / Apto)</label>
          <input type="text" id="input-id" required placeholder="Ej. APTO101" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-indigo-500 uppercase">
        </div>
        <button type="submit" id="btn-submit-login" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2.5 rounded-lg transition shadow-lg flex items-center justify-center">
          Ingresar a la Asamblea
        </button>
      </form>
      <div id="login-error" class="hidden mt-4 text-xs text-red-400 text-center bg-red-900/30 p-2.5 rounded border border-red-800"></div>
    </div>
  </div>

  <!-- CONTENIDO PRINCIPAL -->
  <main class="flex-1 flex flex-col md:flex-row overflow-hidden relative">

    <section class="w-full md:w-7/12 lg:w-8/12 bg-black flex flex-col justify-between relative">
      <div id="video-container" class="w-full h-full flex items-center justify-center bg-gray-950">
        <div class="text-center p-6">
          <i class="fa-solid fa-video text-5xl text-gray-700 mb-3 animate-pulse"></i>
          <p class="text-sm text-gray-400">La transmisión de video iniciará en breve...</p>
        </div>
      </div>
    </section>

    <section class="w-full md:w-5/12 lg:w-4/12 bg-gray-800 border-l border-gray-700 flex flex-col h-full">

      <div class="p-4 bg-gray-900/80 border-b border-gray-700 flex items-center justify-between">
        <div>
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Estado de Votación</h3>
          <span id="voting-status-text" class="text-sm font-bold text-yellow-400">Esperando pregunta...</span>
        </div>
        <div id="timer-box" class="hidden bg-red-900/80 border border-red-600 text-red-200 px-3 py-1 rounded-lg text-center min-w-[70px]">
          <span class="text-[10px] block font-bold text-red-300 uppercase">Tiempo</span>
          <span id="timer-val" class="text-lg font-extrabold leading-none">00s</span>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        
        <div id="question-card" class="hidden bg-gray-900 border border-indigo-500/50 rounded-xl p-4 shadow-lg">
          <h4 id="question-title" class="text-sm font-bold text-white mb-3">---</h4>
          <div id="options-container" class="space-y-2"></div>
          <p class="text-[11px] text-gray-400 mt-3 italic">
            <i class="fa-solid fa-circle-info mr-1 text-indigo-400"></i> Puedes modificar tu voto libremente mientras el cronómetro esté activo.
          </p>
        </div>

        <div id="results-card" class="bg-gray-900 border border-gray-700 rounded-xl p-4 shadow-lg">
          <h4 class="text-xs font-semibold text-gray-300 mb-2 flex items-center justify-between">
            <span>Resultados en Vivo (% Ponderado)</span>
            <i class="fa-solid fa-chart-pie text-indigo-400"></i>
          </h4>
          <div class="h-48 relative">
            <canvas id="resultsChart"></canvas>
          </div>
        </div>

        <div class="bg-gray-900 border border-gray-700 rounded-xl p-4">
          <h4 class="text-xs font-semibold text-gray-300 mb-2">Documentos de la Asamblea</h4>
          <ul id="doc-list" class="space-y-1.5 text-xs text-gray-400">
            <li class="flex items-center justify-between p-2 bg-gray-800 rounded hover:bg-gray-700/50 transition cursor-pointer">
              <span><i class="fa-regular fa-file-pdf text-red-400 mr-2"></i>Orden del Día.pdf</span>
              <i class="fa-solid fa-download text-gray-400"></i>
            </li>
          </ul>
        </div>
      </div>

    </section>
  </main>

  <script>
    const BACKEND_URL = "https://asambleas-backend.onrender.com"; 
    
    let socket = null;
    let currentUser = null;
    let resultsChart = null;

    function initChart() {
      const ctx = document.getElementById('resultsChart').getContext('2d');
      resultsChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['Esperando votación...'],
          datasets: [{
            label: '% Coeficiente',
            data: [0],
            backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#ef4444'],
            borderRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { beginAtZero: true, grid: { color: '#374151' }, ticks: { color: '#9ca3af' } },
            x: { grid: { display: false }, ticks: { color: '#9ca3af' } }
          }
        }
      });
    }

    function connectSocket(identificadorUnico) {
      if (socket) {
        socket.disconnect();
      }

      socket = io(BACKEND_URL, { 
        transports: ['websocket', 'polling'],
        timeout: 25000,
        reconnection: true,
        reconnectionAttempts: 15,
        reconnectionDelay: 1000
      });

      socket.on('connect', () => {
        console.log('🔌 Conectado a WebSockets');
        socket.emit('auth:join', { assemblyId: 1, identificadorUnico: identificadorUnico });
      });

      socket.on('connect_error', (err) => {
        console.error('Error de conexión socket:', err);
        showLoginError('Reconectando con la asamblea... Por favor espera.');
      });

      socket.on('auth:error', (msg) => {
        showLoginError(msg);
        resetLoginButton();
        localStorage.removeItem('asamblea_user_id');
        if (socket) socket.disconnect();
      });

      socket.on('session:invalidated', (data) => {
        alert(data.message);
        logout();
      });

      socket.on('quorum:update', (data) => {
        document.getElementById('quorum-val').innerText = `${data.quorumPercentage}%`;
      });

      socket.on('auth:success', (data) => {
        currentUser = data.user;
        resetLoginButton();

        // PERSISTENCIA DE SESIÓN LOCAL EN EL DISPOSITIVO
        localStorage.setItem('asamblea_user_id', data.user.identificador_unico);

        document.getElementById('login-modal').classList.add('hidden');
        document.getElementById('user-bar').classList.remove('hidden');
        document.getElementById('user-bar').classList.add('flex');
        document.getElementById('btn-logout').classList.remove('hidden');

        document.getElementById('bar-user-id').innerText = data.user.identificador_unico;
        document.getElementById('bar-user-name').innerText = data.user.nombre_completo;
        document.getElementById('bar-user-unit').innerText = data.user.unidad;
        document.getElementById('bar-user-coef').innerText = (parseFloat(data.user.coeficiente) * 100).toFixed(4) + '%';
      });

      socket.on('voting:current_state', (data) => {
        renderQuestion(data);
        if (data.tiempoRestante) {
          document.getElementById('timer-val').innerText = `${data.tiempoRestante}s`;
        }
        if (data.myCurrentVote) {
          const selectedBtn = document.querySelector(`button[data-option-id="${data.myCurrentVote}"]`);
          if (selectedBtn) {
            markButtonAsSelected(selectedBtn);
          }
        }
      });

      socket.on('voting:started', (data) => {
        renderQuestion(data);
      });

      socket.on('timer:tick', (data) => {
        document.getElementById('timer-val').innerText = `${data.tiempoRestante}s`;
      });

      socket.on('voting:results_update', (data) => {
        updateChartData(data.resultados);
      });

      socket.on('voting:closed', (data) => {
        document.getElementById('voting-status-text').innerText = 'Votación Cerrada';
        document.getElementById('voting-status-text').className = 'text-sm font-bold text-red-400';
        document.getElementById('timer-box').classList.add('hidden');
        updateChartData(data.resultados);
      });
    }

    function renderQuestion(q) {
      document.getElementById('voting-status-text').innerText = 'Votación En Curso';
      document.getElementById('voting-status-text').className = 'text-sm font-bold text-emerald-400';
      document.getElementById('timer-box').classList.remove('hidden');
      document.getElementById('question-card').classList.remove('hidden');
      document.getElementById('question-title').innerText = q.texto;

      const container = document.getElementById('options-container');
      container.innerHTML = '';

      q.opciones.forEach(opt => {
        const btn = document.createElement('button');
        btn.setAttribute('data-option-id', opt.id);
        btn.className = "w-full text-left p-3 rounded-lg bg-gray-800 hover:bg-indigo-600/30 border border-gray-700 hover:border-indigo-500 transition text-sm flex items-center justify-between group";
        btn.innerHTML = `<span>${opt.texto_opcion}</span> <i class="fa-regular fa-circle text-gray-500 group-hover:text-indigo-400"></i>`;
        btn.onclick = () => submitVote(opt.id, btn);
        container.appendChild(btn);
      });
    }

    function markButtonAsSelected(btnElement) {
      document.querySelectorAll('#options-container button').forEach(b => {
        b.className = "w-full text-left p-3 rounded-lg bg-gray-800 border border-gray-700 text-sm flex items-center justify-between";
      });
      btnElement.className = "w-full text-left p-3 rounded-lg bg-indigo-900/60 border border-indigo-500 text-sm font-semibold flex items-center justify-between text-indigo-200";
    }

    function submitVote(optionId, btnElement) {
      if (!socket) return;
      socket.emit('vote:submit', { opcionId: optionId });
      markButtonAsSelected(btnElement);
    }

    function updateChartData(results) {
      if (!resultsChart) return;
      const labels = [];
      const data = [];

      Object.values(results).forEach(r => {
        labels.push(r.texto);
        data.push((r.coeficienteAcumulado * 100).toFixed(4));
      });

      resultsChart.data.labels = labels;
      resultsChart.data.datasets[0].data = data;
      resultsChart.update();
    }

    function iniciarSesion(e) {
      if(e) e.preventDefault();
      const id = document.getElementById('input-id').value.trim().toUpperCase();
      const btn = document.getElementById('btn-submit-login');
      const errorDiv = document.getElementById('login-error');

      if (!id) return;

      errorDiv.classList.add('hidden');
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner animate-spin mr-2"></i>Conectando...`;

      connectSocket(id);
    }

    function resetLoginButton() {
      const btn = document.getElementById('btn-submit-login');
      btn.disabled = false;
      btn.innerText = 'Ingresar a la Asamblea';
    }

    function showLoginError(msg) {
      const errorDiv = document.getElementById('login-error');
      errorDiv.innerText = msg;
      errorDiv.classList.remove('hidden');
    }

    function logout() {
      localStorage.removeItem('asamblea_user_id');
      if (socket) socket.disconnect();
      document.getElementById('login-modal').classList.remove('hidden');
      document.getElementById('user-bar').classList.add('hidden');
      document.getElementById('user-bar').classList.remove('flex');
      document.getElementById('btn-logout').classList.add('hidden');
      document.getElementById('input-id').value = '';
      resetLoginButton();
    }

    // AUTO-RECONEXIÓN AL DESBLOQUEAR EL MÓVIL O NAVEGAR
    window.onload = () => {
      initChart();
      const savedUser = localStorage.getItem('asamblea_user_id');
      if (savedUser) {
        document.getElementById('input-id').value = savedUser;
        iniciarSesion(null);
      }
    };
  </script>
</body>
</html>
