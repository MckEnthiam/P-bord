const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============================================================================
// STORAGE
// ============================================================================
const CLASSROOMS_FILE = 'classrooms.json';
let classrooms = new Map();

// Charger les classes sauvegardées
function loadClassrooms() {
  try {
    if (fs.existsSync(CLASSROOMS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLASSROOMS_FILE, 'utf8'));
      Object.entries(data).forEach(([code, classroom]) => {
        classrooms.set(code, {
          ...classroom,
          students: new Map(Object.entries(classroom.students || {}))
        });
      });
      console.log(`✅ ${classrooms.size} classe(s) chargée(s)`);
    }
  } catch (error) {
    console.error('❌ Erreur chargement:', error);
  }
}

// Sauvegarder les classes
function saveClassrooms() {
  try {
    const data = {};
    classrooms.forEach((classroom, code) => {
      data[code] = {
        ...classroom,
        students: Object.fromEntries(classroom.students)
      };
    });
    fs.writeFileSync(CLASSROOMS_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log(`💾 ${classrooms.size} classe(s) sauvegardée(s)`);
  } catch (error) {
    console.error('❌ Erreur sauvegarde:', error);
  }
}

loadClassrooms();

// Sauvegarde automatique toutes les 10 secondes
setInterval(saveClassrooms, 10000);

// ============================================================================
// ROUTES API
// ============================================================================

// Créer une classe
app.post('/api/classroom/create', (req, res) => {
  const { classCode, className, adminName, clientId } = req.body;
  
  if (!classCode || !className || !adminName || !clientId) {
    return res.status(400).json({ error: 'Données manquantes' });
  }
  
  const classroom = {
    code: classCode,
    className,
    adminId: clientId,
    adminName,
    students: new Map([[clientId, {
      userName: adminName,
      isAdmin: true,
      handRaised: false,
      lastSeen: Date.now()
    }]]),
    canvasState: null,
    isLocked: false,
    createdAt: Date.now(),
    lastModified: Date.now(),
    drawBuffer: []
  };
  
  classrooms.set(classCode, classroom);
  saveClassrooms();
  
  console.log(`🎓 Classe créée: ${classCode} par ${adminName}`);
  
  res.json({ success: true, classCode, className });
});

// Rejoindre une classe
app.post('/api/classroom/join', (req, res) => {
  const { classCode, userName, clientId } = req.body;
  
  if (!classCode || !userName || !clientId) {
    return res.status(400).json({ error: 'Données manquantes' });
  }
  
  const classroom = classrooms.get(classCode);
  
  if (!classroom) {
    return res.status(404).json({ error: 'Classe introuvable' });
  }
  
  classroom.students.set(clientId, {
    userName,
    isAdmin: false,
    handRaised: false,
    lastSeen: Date.now()
  });
  
  classroom.lastModified = Date.now();
  saveClassrooms();
  
  console.log(`👤 ${userName} a rejoint ${classCode} - Total: ${classroom.students.size}`);
  
  res.json({
    success: true,
    className: classroom.className,
    isLocked: classroom.isLocked,
    canvasState: classroom.canvasState
  });
});

// Récupérer l'état d'une classe
app.get('/api/classroom/:classCode', (req, res) => {
  const { classCode } = req.params;
  const classroom = classrooms.get(classCode);
  
  if (!classroom) {
    return res.status(404).json({ error: 'Classe introuvable' });
  }
  
  // Nettoyer les étudiants inactifs (plus de 30 secondes)
  const now = Date.now();
  const inactiveThreshold = 30000;
  
  classroom.students.forEach((student, id) => {
    if (now - student.lastSeen > inactiveThreshold) {
      classroom.students.delete(id);
    }
  });
  
  const students = Array.from(classroom.students.entries()).map(([id, student]) => ({
    clientId: id,
    userName: student.userName,
    isAdmin: student.isAdmin,
    handRaised: student.handRaised
  }));
  
  res.json({
    className: classroom.className,
    isLocked: classroom.isLocked,
    students,
    canvasState: classroom.canvasState,
    lastModified: classroom.lastModified,
    drawBuffer: classroom.drawBuffer.slice(-50) // Derniers 50 traits
  });
});

// Sauvegarder l'état du canvas
app.post('/api/classroom/save-canvas', (req, res) => {
  const { classCode, canvasState, clientId } = req.body;
  
  const classroom = classrooms.get(classCode);
  
  if (!classroom) {
    return res.status(404).json({ error: 'Classe introuvable' });
  }
  
  const student = classroom.students.get(clientId);
  
  if (!student || !student.isAdmin) {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  
  classroom.canvasState = canvasState;
  classroom.lastModified = Date.now();
  saveClassrooms();
  
  res.json({ success: true });
});

// Dessiner
app.post('/api/classroom/draw', (req, res) => {
  const { classCode, clientId, x0, y0, x1, y1, color, size, tool } = req.body;
  
  const classroom = classrooms.get(classCode);
  
  if (!classroom) {
    return res.status(404).json({ error: 'Classe introuvable' });
  }
  
  const student = classroom.students.get(clientId);
  
  if (!student) {
    return res.status(404).json({ error: 'Étudiant introuvable' });
  }
  
  // Vérifier si autorisé à dessiner
  if (classroom.isLocked && !student.isAdmin) {
    return res.status(403).json({ error: 'Tableau verrouillé' });
  }
  
  student.lastSeen = Date.now();
  
  // Ajouter au buffer de traits
  const drawData = { clientId, x0, y0, x1, y1, color, size, tool, timestamp: Date.now() };
  
  if (!classroom.drawBuffer) {
    classroom.drawBuffer = [];
  }
  
  classroom.drawBuffer.push(drawData);
  
  // Garder seulement les 100 derniers traits
  if (classroom.drawBuffer.length > 100) {
    classroom.drawBuffer = classroom.drawBuffer.slice(-100);
  }
  
  classroom.lastModified = Date.now();
  
  res.json({ success: true });
});

// Effacer le canvas
app.post('/api/classroom/clear', (req, res) => {
  const { classCode, clientId } = req.body;
  
  const classroom = classrooms.get(classCode);
  
  if (!classroom) {
    return res.status(404).json({ error: 'Classe introuvable' });
  }
  
  const student = classroom.students.get(clientId);
  
  if (!student || (classroom.isLocked && !student.isAdmin)) {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  
  classroom.canvasState = null;
  classroom.drawBuffer = [];
  classroom.lastModified = Date.now();
  saveClassrooms();
  
  console.log(`🗑️  Canvas effacé dans ${classCode}`);
  
  res.json({ success: true });
});

// Verrouiller/Déverrouiller
app.post('/api/classroom/lock', (req, res) => {
  const { classCode, locked, clientId } = req.body;
  
  const classroom = classrooms.get(classCode);
  
  if (!classroom) {
    return res.status(404).json({ error: 'Classe introuvable' });
  }
  
  const student = classroom.students.get(clientId);
  
  if (!student || !student.isAdmin) {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  
  classroom.isLocked = locked;
  classroom.lastModified = Date.now();
  saveClassrooms();
  
  console.log(`🔒 Classe ${classCode} ${locked ? 'verrouillée' : 'déverrouillée'}`);
  
  res.json({ success: true });
});

// Lever la main
app.post('/api/classroom/raise-hand', (req, res) => {
  const { classCode, clientId, userName, raised } = req.body;
  
  const classroom = classrooms.get(classCode);
  
  if (!classroom) {
    return res.status(404).json({ error: 'Classe introuvable' });
  }
  
  let student = classroom.students.get(clientId);
  
  if (!student) {
    // Ajouter l'étudiant s'il n'existe pas
    student = {
      userName,
      isAdmin: false,
      handRaised: raised,
      lastSeen: Date.now()
    };
    classroom.students.set(clientId, student);
  } else {
    student.handRaised = raised;
    student.lastSeen = Date.now();
  }
  
  classroom.lastModified = Date.now();
  
  console.log(`✋ ${userName} ${raised ? 'lève' : 'baisse'} la main dans ${classCode}`);
  
  res.json({ success: true });
});

// Baisser toutes les mains
app.post('/api/classroom/clear-hands', (req, res) => {
  const { classCode, clientId } = req.body;
  
  const classroom = classrooms.get(classCode);
  
  if (!classroom) {
    return res.status(404).json({ error: 'Classe introuvable' });
  }
  
  const student = classroom.students.get(clientId);
  
  if (!student || !student.isAdmin) {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  
  classroom.students.forEach(s => {
    s.handRaised = false;
  });
  
  classroom.lastModified = Date.now();
  
  console.log(`✋ Toutes les mains baissées dans ${classCode}`);
  
  res.json({ success: true });
});

// Statistiques
app.get('/api/stats', (req, res) => {
  let totalStudents = 0;
  let activeClasses = 0;
  
  classrooms.forEach(classroom => {
    if (classroom.students.size > 0) {
      activeClasses++;
      totalStudents += classroom.students.size;
    }
  });
  
  res.json({
    totalClasses: classrooms.size,
    activeClasses,
    totalStudents,
    uptime: process.uptime()
  });
});

// ============================================================================
// NETTOYAGE AUTOMATIQUE
// ============================================================================

// Nettoyer les classes vides toutes les heures
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 heures
  
  classrooms.forEach((classroom, code) => {
    // Supprimer les étudiants inactifs
    classroom.students.forEach((student, id) => {
      if (now - student.lastSeen > 60000) { // 1 minute
        classroom.students.delete(id);
      }
    });
    
    // Supprimer les classes vides et anciennes
    if (classroom.students.size === 0 && (now - classroom.createdAt) > maxAge) {
      classrooms.delete(code);
      console.log(`🗑️  Classe ${code} supprimée (expirée)`);
    }
  });
  
  saveClassrooms();
}, 3600000); // Toutes les heures

// ============================================================================
// DÉMARRAGE DU SERVEUR
// ============================================================================

app.listen(PORT, () => {
  console.log(`🚀 Serveur HTTP démarré sur http://localhost:${PORT}`);
  console.log(`📊 ${classrooms.size} classe(s) active(s)`);
});

// Sauvegarde avant arrêt
process.on('SIGINT', () => {
  console.log('\n🛑 Arrêt du serveur...');
  saveClassrooms();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Arrêt du serveur...');
  saveClassrooms();
  process.exit(0);
});