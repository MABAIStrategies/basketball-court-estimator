import React, { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';

// --- 2026 LIVE PRICING DATA ---
const PRICING = {
  concretePerSqFt: 10.00,
  tileBrands: [
    { id: 'versacourt-active', name: 'VersaCourt Active', pricePerSqFt: 5.24, link: 'https://www.greatmats.com/versacourt-tiles.php' },
    { id: 'versacourt-boost', name: 'VersaCourt Boost', pricePerSqFt: 3.96, link: 'https://www.greatmats.com/versacourt-tiles.php' }
  ],
  hoops: [
    { id: 'megaslam-72', name: 'Mega Slam 72', price: 2799, link: 'https://www.megaslamhoops.com/basketball-hoops/in-ground-adjustable/megaslam-72', specs: '72" Glass Backboard, 8x6 Pole' },
    { id: 'megaslam-60', name: 'Mega Slam 60', price: 2499, link: 'https://www.megaslamhoops.com/basketball-hoops/in-ground-adjustable/megaslam-60', specs: '60" Glass Backboard, 6x6 Pole' },
    { id: 'goalrilla-cv54', name: 'Goalrilla CV54', price: 2149, link: 'https://www.recunlimited.com/product-category/basketball-goals/goalrilla/goalrilla-goals/54-goalrilla-goals/', specs: '54" Glass Backboard' }
  ],
  accessories: {
    lighting: { price: 1500, label: 'Dual LED Light Towers' },
    netting: { price: 299, label: 'Rebound Net Protect' }
  }
};

const COURT_SIZES = [
  { id: 'half-small', name: 'Backyard Compact', width: 30, length: 30 },
  { id: 'half-standard', name: 'Standard Half Court', width: 30, length: 50 },
  { id: 'nba-half', name: 'NBA Half Court', width: 47, length: 50 }
];

const COLORS = [
  { id: 'blue', hex: '#1e3a8a', name: 'Pro Blue' },
  { id: 'red', hex: '#991b1b', name: 'Arena Red' },
  { id: 'green', hex: '#166534', name: 'Classic Green' },
  { id: 'grey', hex: '#374151', name: 'Asphalt Grey' }
];

const apiKey = ""; // Injected at runtime

// Generates a normal map for modular sport tiles (creates the plastic grid look)
const createTileNormalMap = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  
  // Base normal pointing straight up (Z-axis in tangent space)
  ctx.fillStyle = '#8080ff'; 
  ctx.fillRect(0, 0, 128, 128);
  
  // Beveled edges to catch light
  ctx.fillStyle = '#8000ff'; ctx.fillRect(0, 0, 6, 128); // Left
  ctx.fillStyle = '#80ffff'; ctx.fillRect(122, 0, 6, 128); // Right
  ctx.fillStyle = '#0080ff'; ctx.fillRect(0, 0, 128, 6); // Top
  ctx.fillStyle = '#ff80ff'; ctx.fillRect(0, 122, 128, 6); // Bottom
  
  // Perforated drainage holes (creates texture)
  ctx.fillStyle = '#808080';
  for(let i=16; i<128; i+=16) {
    for(let j=16; j<128; j+=16) {
      ctx.beginPath();
      ctx.arc(i, j, 4, 0, Math.PI*2);
      ctx.fill();
    }
  }
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
};

// Generates the white target square for the backboard
const createBackboardLines = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,512,256);
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 8;
  ctx.strokeRect(176, 80, 160, 120); // Inner target square
  ctx.lineWidth = 12;
  ctx.strokeRect(6, 6, 500, 244); // Outer border
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
};

export default function App() {
  const mountRef = useRef(null);
  const arContainerRef = useRef(null);
  const [step, setStep] = useState(0); 
  
  const [config, setConfig] = useState({
    sizeIndex: 1,
    tileIndex: 0,
    mainColor: '#1e3a8a',
    keyColor: '#991b1b',
    hoopIndex: 0,
    hasLighting: true,
    hasNetting: false
  });

  const [aiThemePrompt, setAiThemePrompt] = useState("");
  const [isGeneratingColors, setIsGeneratingColors] = useState(false);
  const [courtHype, setCourtHype] = useState(null);
  const [isGeneratingHype, setIsGeneratingHype] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [isARSupported, setIsARSupported] = useState(false);

  const sceneRefs = useRef({
    scene: null, camera: null, renderer: null, controls: null, masterGroup: null,
    courtMat: null, keyMat: null, linesGroup: null,
    hoopGroup: null, lightGroup: null, reticle: null, hitTestSourceRequested: false, hitTestSource: null,
    targetCamPos: new THREE.Vector3(0, 30, 40),
    targetLookAt: new THREE.Vector3(0, 0, 0),
    currentLookAt: new THREE.Vector3(0, 0, 0),
    exploreMode: false, arPlaced: false
  });

  const currentSize = COURT_SIZES[config.sizeIndex];
  const sqft = currentSize.width * currentSize.length;
  const totalCost = (sqft * PRICING.concretePerSqFt) + (sqft * PRICING.tileBrands[config.tileIndex].pricePerSqFt) + 
                    PRICING.hoops[config.hoopIndex].price + (config.hasLighting ? 1500 : 0) + (config.hasNetting ? 299 : 0);

  const callGemini = async (prompt, isJson = false) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: "You are a helpful assistant for a basketball court builder app." }] }
    };
    if (isJson) {
      payload.generationConfig = { responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { mainColor: { type: "STRING" }, keyColor: { type: "STRING" } } } };
    }
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        return isJson ? JSON.parse(data.candidates[0].content.parts[0].text) : data.candidates[0].content.parts[0].text;
      } catch (e) {
        if (i === 4) throw e;
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
      }
    }
  };

  const handleAiTheme = async () => {
    if (!aiThemePrompt.trim()) return;
    setIsGeneratingColors(true);
    try {
      const result = await callGemini(`Theme matching: "${aiThemePrompt}". Suggest main court color and key color. Return ONLY valid JSON with hex color codes.`, true);
      if (result.mainColor) setConfig(p => ({...p, mainColor: result.mainColor}));
      if (result.keyColor) setConfig(p => ({...p, keyColor: result.keyColor}));
    } catch (e) { setAiError("Failed to generate colors."); } finally { setIsGeneratingColors(false); }
  };

  const handleGenerateHype = async () => {
    setIsGeneratingHype(true);
    try {
      const prompt = `You are a hype-man announcer. Write a 2-3 sentence scouting report for a new court. Size: ${currentSize.name}, Hoop: ${PRICING.hoops[config.hoopIndex].name}. Make it sound like the ultimate home court advantage. No markdown.`;
      setCourtHype(await callGemini(prompt, false));
    } catch (e) { setAiError("Failed to generate hype report."); } finally { setIsGeneratingHype(false); }
  };

  useEffect(() => {
    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#87CEEB');

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 50, 80);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.xr.enabled = true; // ENABLE AR
    mountRef.current.appendChild(renderer.domElement);

    // Generate Photorealistic Lighting Environment
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enabled = false;
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;

    // Lighting Setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(30, 80, 50);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.bias = -0.0001;
    scene.add(dirLight);

    // Master Group (Used to place entire scene in AR mode)
    const masterGroup = new THREE.Group();
    scene.add(masterGroup);

    // 1. Concrete Slab
    const slabGeo = new THREE.BoxGeometry(1, 0.5, 1);
    const slabMat = new THREE.MeshStandardMaterial({ color: '#555555', roughness: 0.9 });
    const slabMesh = new THREE.Mesh(slabGeo, slabMat);
    slabMesh.position.y = -0.25;
    slabMesh.receiveShadow = true;
    masterGroup.add(slabMesh);

    // 2. Tile normal map for realistic plastic texture
    const tileNormalMap = createTileNormalMap();
    
    // Main Court Surface
    const courtMat = new THREE.MeshPhysicalMaterial({ 
      color: config.mainColor, roughness: 0.6, metalness: 0.1, 
      normalMap: tileNormalMap, clearcoat: 0.1, clearcoatRoughness: 0.5,
      polygonOffset: true, polygonOffsetFactor: 1
    });
    const courtMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), courtMat);
    courtMesh.rotation.x = -Math.PI / 2;
    courtMesh.receiveShadow = true;
    masterGroup.add(courtMesh);

    // Key Area
    const keyMat = new THREE.MeshPhysicalMaterial({ 
      color: config.keyColor, roughness: 0.6, metalness: 0.1, 
      normalMap: tileNormalMap, clearcoat: 0.1, clearcoatRoughness: 0.5,
      polygonOffset: true, polygonOffsetFactor: 0
    });
    const keyMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), keyMat);
    keyMesh.rotation.x = -Math.PI / 2;
    keyMesh.position.y = 0.005; 
    keyMesh.receiveShadow = true;
    masterGroup.add(keyMesh);

    // Geometric Court Lines (Crisp 4K Lines)
    const linesGroup = new THREE.Group();
    linesGroup.position.y = 0.01; // Just above the key
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    
    // Key Border
    const keyBorderLeft = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 19), lineMat);
    keyBorderLeft.rotation.x = -Math.PI/2; keyBorderLeft.position.set(-8, 0, 9.5);
    const keyBorderRight = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 19), lineMat);
    keyBorderRight.rotation.x = -Math.PI/2; keyBorderRight.position.set(8, 0, 9.5);
    const keyBorderTop = new THREE.Mesh(new THREE.PlaneGeometry(16, 0.2), lineMat);
    keyBorderTop.rotation.x = -Math.PI/2; keyBorderTop.position.set(0, 0, 19);
    
    // Free throw circle
    const ftCircle = new THREE.Mesh(new THREE.RingGeometry(5.9, 6.1, 32), lineMat);
    ftCircle.rotation.x = -Math.PI/2; ftCircle.position.set(0, 0, 19);
    
    // 3PT Arc (High School/College standard ~19.75ft)
    const threePtArc = new THREE.Mesh(new THREE.RingGeometry(19.75, 19.95, 64, 1, 0, Math.PI), lineMat);
    threePtArc.rotation.x = -Math.PI/2; threePtArc.position.set(0, 0, 5.25);

    linesGroup.add(keyBorderLeft, keyBorderRight, keyBorderTop, ftCircle, threePtArc);
    masterGroup.add(linesGroup);

    const hoopGroup = new THREE.Group();
    const steelMat = new THREE.MeshPhysicalMaterial({ color: '#111111', metalness: 0.9, roughness: 0.3, clearcoat: 0.5 });
    
    // Massive Pole
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.6, 10, 0.6), steelMat);
    pole.position.set(0, 5, -2.5); pole.castShadow = true; pole.receiveShadow = true;
    hoopGroup.add(pole);

    // Extension Arms (Dual structure)
    const armGeo = new THREE.BoxGeometry(0.2, 0.4, 3);
    const arm1 = new THREE.Mesh(armGeo, steelMat); arm1.position.set(-0.3, 8.5, -1); arm1.castShadow = true;
    const arm2 = new THREE.Mesh(armGeo, steelMat); arm2.position.set(0.3, 8.5, -1); arm2.castShadow = true;
    const arm3 = new THREE.Mesh(armGeo, steelMat); arm3.position.set(-0.3, 9.5, -1); arm3.castShadow = true;
    const arm4 = new THREE.Mesh(armGeo, steelMat); arm4.position.set(0.3, 9.5, -1); arm4.castShadow = true;
    hoopGroup.add(arm1, arm2, arm3, arm4);

    // Glass Backboard (Hyper-Realistic transmission)
    const bbLinesTex = createBackboardLines();
    const bbGlassMat = new THREE.MeshPhysicalMaterial({ 
      color: 0xffffff, transmission: 0.98, opacity: 1, metalness: 0.1, roughness: 0.01,
      ior: 1.5, thickness: 0.1, map: bbLinesTex, transparent: true
    });
    const backboard = new THREE.Mesh(new THREE.BoxGeometry(6, 3.5, 0.05), bbGlassMat);
    backboard.position.set(0, 9, 0.5); backboard.castShadow = true;
    hoopGroup.add(backboard);

    // Backboard Frame
    const frameGeo = new THREE.BoxGeometry(6.2, 3.7, 0.04);
    const frameMat = new THREE.MeshStandardMaterial({ color: '#e0e0e0', metalness: 0.8, roughness: 0.2 });
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.set(0, 9, 0.47);
    hoopGroup.add(frame);

    // Protective Padding
    const pad = new THREE.Mesh(new THREE.BoxGeometry(6.3, 0.3, 0.2), new THREE.MeshStandardMaterial({ color: '#111111', roughness: 0.9 }));
    pad.position.set(0, 7.2, 0.5);
    hoopGroup.add(pad);

    // Breakaway Rim Mechanism
    const springBox = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.5), steelMat);
    springBox.position.set(0, 8.5, 0.75); springBox.castShadow = true;
    hoopGroup.add(springBox);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.06, 16, 50), new THREE.MeshPhysicalMaterial({ color: '#ff3300', metalness: 0.4, roughness: 0.4, clearcoat: 0.8 }));
    rim.rotation.x = Math.PI / 2; rim.position.set(0, 8.5, 1.6); rim.castShadow = true;
    hoopGroup.add(rim);

    // High-poly Net
    const netGeo = new THREE.CylinderGeometry(0.75, 0.55, 1.4, 16, 4, true);
    const netMat = new THREE.MeshStandardMaterial({ color: '#ffffff', wireframe: true, transparent: true, opacity: 0.8 });
    const net = new THREE.Mesh(netGeo, netMat);
    net.position.set(0, 7.8, 1.6);
    hoopGroup.add(net);

    masterGroup.add(hoopGroup);

    // Light Towers
    const lightGroup = new THREE.Group();
    const lPoleMat = new THREE.MeshStandardMaterial({ color: '#222', roughness: 0.5 });
    const lPole1 = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 16), lPoleMat);
    lPole1.position.set(-15, 8, 10); lPole1.castShadow = true;
    const spotLight1 = new THREE.SpotLight(0xffffff, 1.5, 0, Math.PI/3, 0.5, 1);
    spotLight1.position.set(-15, 16, 10); spotLight1.target = courtMesh; spotLight1.castShadow = true;
    
    lightGroup.add(lPole1, spotLight1);
    masterGroup.add(lightGroup);

    // AR Reticle (Target Ring)
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x00ff00 })
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    if ('xr' in navigator) {
      navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
        setIsARSupported(supported);
        if (supported) {
          const arBtn = ARButton.createButton(renderer, { requiredFeatures: ['hit-test'] });
          arBtn.style.display = 'none'; // Hide default, we will trigger it from our UI
          arBtn.id = 'hidden-ar-btn';
          if(arContainerRef.current) arContainerRef.current.appendChild(arBtn);
        }
      });
    }

    // AR Tap Event to Place Court
    const onSelect = () => {
      if (reticle.visible) {
        masterGroup.position.setFromMatrixPosition(reticle.matrix);
        // Scale down slightly for AR so it fits in backyard easier, but keep realistic proportions
        masterGroup.scale.set(0.2, 0.2, 0.2); 
        sceneRefs.current.arPlaced = true;
      }
    };
    const controller = renderer.xr.getController(0);
    controller.addEventListener('select', onSelect);
    scene.add(controller);

    // Save refs
    sceneRefs.current = { 
      scene, camera, renderer, controls, masterGroup,
      courtMat, keyMat, linesGroup, hoopGroup, lightGroup, reticle, hitTestSourceRequested: false, hitTestSource: null,
      targetCamPos: new THREE.Vector3(0, 30, 40), targetLookAt: new THREE.Vector3(0, 0, 0), currentLookAt: new THREE.Vector3(0, 0, 0),
      exploreMode: false, arPlaced: false, slabMesh, courtMesh, keyMesh
    };

    renderer.setAnimationLoop((timestamp, frame) => {
      // Handle AR Hit Testing
      if (frame) {
        const referenceSpace = renderer.xr.getReferenceSpace();
        const session = renderer.xr.getSession();
        if (sceneRefs.current.hitTestSourceRequested === false) {
          session.requestReferenceSpace('viewer').then((refSpace) => {
            session.requestHitTestSource({ space: refSpace }).then((source) => {
              sceneRefs.current.hitTestSource = source;
            });
          });
          session.addEventListener('end', () => {
            sceneRefs.current.hitTestSourceRequested = false;
            sceneRefs.current.hitTestSource = null;
            sceneRefs.current.arPlaced = false;
            masterGroup.position.set(0,0,0); // Reset position
            masterGroup.scale.set(1,1,1); // Reset scale
            scene.background = new THREE.Color('#87CEEB'); // Restore sky
          });
          sceneRefs.current.hitTestSourceRequested = true;
          scene.background = null; // Clear sky for AR camera passthrough
        }

        if (sceneRefs.current.hitTestSource && !sceneRefs.current.arPlaced) {
          const hitTestResults = frame.getHitTestResults(sceneRefs.current.hitTestSource);
          if (hitTestResults.length > 0) {
            const hit = hitTestResults[0];
            reticle.visible = true;
            reticle.matrix.fromArray(hit.getPose(referenceSpace).transform.matrix);
          } else {
            reticle.visible = false;
          }
        } else {
          reticle.visible = false;
        }
      }

      // Smooth Camera Swoop (only when NOT in AR and NOT in Explore Mode)
      if (!renderer.xr.isPresenting) {
        if (!sceneRefs.current.exploreMode) {
          camera.position.lerp(sceneRefs.current.targetCamPos, 0.05);
          sceneRefs.current.currentLookAt.lerp(sceneRefs.current.targetLookAt, 0.05);
          camera.lookAt(sceneRefs.current.currentLookAt);
        } else {
          controls.update();
        }
      }

      renderer.render(scene, camera);
    });

    const handleResize = () => {
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.setAnimationLoop(null);
      if(mountRef.current && renderer.domElement) mountRef.current.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const { courtMat, keyMat, slabMesh, courtMesh, keyMesh, linesGroup, hoopGroup, lightGroup, targetCamPos, targetLookAt } = sceneRefs.current;
    if (!courtMat) return;

    // Dimensions
    const size = COURT_SIZES[config.sizeIndex];
    const w = size.width;
    const l = size.length;

    // Scale meshes
    courtMesh.scale.set(w, l, 1);
    slabMesh.scale.set(w + 1, 1, l + 1); 
    
    // Scale Normal Maps based on width to keep tiles proportionately 1x1 foot
    courtMat.normalMap.repeat.set(w, l);
    keyMat.normalMap.repeat.set(16, 19);

    // Position Key & Lines
    keyMesh.scale.set(16, 19, 1);
    keyMesh.position.set(0, 0.005, -l/2 + 9.5); 
    linesGroup.position.set(0, 0.01, -l/2); 

    // Position Hoop
    hoopGroup.position.set(0, 0, -l/2);

    // Adjust Hoop size based on selection
    const bbMesh = hoopGroup.children[5]; // Backboard
    const bbFrame = hoopGroup.children[6]; // Frame
    if(config.hoopIndex === 0) { // 72 inch
       bbMesh.scale.set(1, 1, 1); bbFrame.scale.set(1, 1, 1);
    } else if (config.hoopIndex === 1) { // 60 inch
       bbMesh.scale.set(60/72, 1, 1); bbFrame.scale.set(60/72, 1, 1);
    } else { // 54 inch
       bbMesh.scale.set(54/72, 54/72, 1); bbFrame.scale.set(54/72, 54/72, 1);
    }

    // Position Lights dynamically
    lightGroup.children[0].position.x = -w/2 - 2; // Pole
    lightGroup.children[1].position.x = -w/2 - 2; // SpotLight
    lightGroup.visible = config.hasLighting;

    // Colors
    courtMat.color.set(config.mainColor);
    keyMat.color.set(config.keyColor);

    // Cinematic Swoop Logic
    switch (step) {
      case 0: targetCamPos.set(0, 30, w * 1.5); targetLookAt.set(0, 0, 0); break;
      case 1: targetCamPos.set(0, l * 0.9, l * 0.9); targetLookAt.set(0, 0, 0); break;
      case 2: targetCamPos.set(-w/2 + 5, 4, l/2 - 5); targetLookAt.set(0, 0, -l/4); break;
      case 3: targetCamPos.set(5, 12, -l/2 + 18); targetLookAt.set(0, 9, -l/2); break; // Sweeping look at hoop
      case 4: targetCamPos.set(-w/1.2, 15, l/3); targetLookAt.set(0, 5, 0); break;
      case 5: 
        sceneRefs.current.exploreMode = true;
        sceneRefs.current.controls.enabled = true;
        sceneRefs.current.camera.position.set(0, 6, l/2 - 5);
        sceneRefs.current.controls.target.set(0, 6, -l/2); 
        break;
      default: break;
    }

    if (step !== 5) {
      sceneRefs.current.exploreMode = false;
      sceneRefs.current.controls.enabled = false;
    }

  }, [config, step]);

  const triggerAR = () => {
    const btn = document.getElementById('hidden-ar-btn');
    if(btn) btn.click();
  };

  const formatCurrency = (a) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(a);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-gray-900 font-sans text-white">
      <div ref={arContainerRef} className="hidden" />
      <div ref={mountRef} className="absolute inset-0 z-0 cursor-move" />

      {/* Header Estimate Tracker */}
      <div className="absolute top-0 left-0 w-full p-6 z-10 pointer-events-none flex justify-between items-start">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight drop-shadow-lg text-white">
            Court<span className="text-blue-500">Builder</span> Pro
          </h1>
          <p className="text-gray-300 text-sm mt-1 drop-shadow-md">Acutely Realistic 4K Visualizer</p>
        </div>
        
        {step > 0 && (
          <div className="bg-black/60 backdrop-blur-md border border-gray-700 p-4 rounded-xl shadow-2xl pointer-events-auto text-right w-72 transition-all duration-500">
            <div className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-2">Live Estimate (2026)</div>
            <div className="flex justify-between text-sm mb-1"><span className="text-gray-300">Concrete Slab Base:</span><span>{formatCurrency(sqft * PRICING.concretePerSqFt)}</span></div>
            <div className="flex justify-between text-sm mb-1"><span className="text-gray-300">Sport Surface:</span><span>{formatCurrency(sqft * PRICING.tileBrands[config.tileIndex].pricePerSqFt)}</span></div>
            <div className="flex justify-between text-sm mb-1"><span className="text-gray-300">Hoop System:</span><span>{formatCurrency(PRICING.hoops[config.hoopIndex].price)}</span></div>
            {(config.hasLighting || config.hasNetting) && (
              <div className="flex justify-between text-sm mb-1"><span className="text-gray-300">Accessories:</span><span>{formatCurrency((config.hasLighting?1500:0) + (config.hasNetting?299:0))}</span></div>
            )}
            <div className="border-t border-gray-600 my-2"></div>
            <div className="flex justify-between items-end">
              <span className="text-lg font-bold text-gray-100">Total:</span>
              <span className="text-3xl font-extrabold text-green-400">{formatCurrency(totalCost)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Control Panel (Steps 0-4) */}
      {step < 5 && (
        <div className="absolute bottom-10 left-1/2 transform -translate-x-1/2 w-[90%] max-w-4xl bg-black/50 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-2xl z-20 flex flex-col">
          
          <div className="flex justify-between mb-8 relative">
            <div className="absolute top-1/2 left-0 w-full h-1 bg-gray-700 -z-10 transform -translate-y-1/2 rounded-full"></div>
            <div className="absolute top-1/2 left-0 h-1 bg-blue-500 -z-10 transform -translate-y-1/2 rounded-full transition-all duration-500" style={{ width: `${(step / 4) * 100}%` }}></div>
            {['Start', 'Size', 'Surface', 'Hoop', 'Extras'].map((label, i) => (
              <div key={label} className="flex flex-col items-center cursor-pointer" onClick={() => setStep(i)}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-300 ${step >= i ? 'bg-blue-500 text-white shadow-[0_0_15px_rgba(59,130,246,0.5)]' : 'bg-gray-800 text-gray-500'}`}>{i}</div>
                <span className={`text-xs mt-2 font-medium ${step >= i ? 'text-white' : 'text-gray-500'}`}>{label}</span>
              </div>
            ))}
          </div>

          <div className="flex-grow min-h-[220px]">
            {step === 0 && (
              <div className="text-center py-6 animate-fade-in">
                <h2 className="text-3xl font-bold mb-4">Build Your Dream Court</h2>
                <p className="text-gray-300 mb-8 max-w-xl mx-auto">Experience a multi-step, highly customizable journey with hyper-realistic 4K rendering and AR capabilities.</p>
                <button onClick={() => setStep(1)} className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-10 rounded-full shadow-lg transition-transform hover:scale-105">Start Building</button>
              </div>
            )}

            {step === 1 && (
              <div className="animate-fade-in grid grid-cols-3 gap-4">
                <div className="col-span-3 mb-2">
                  <h3 className="text-xl font-bold">1. Select Court Dimensions</h3>
                  <p className="text-sm text-gray-400">Includes 4-inch concrete slab foundation base.</p>
                </div>
                {COURT_SIZES.map((size, index) => (
                  <button key={size.id} onClick={() => setConfig(p=>({...p, sizeIndex: index}))} className={`p-4 rounded-xl border text-left transition-all ${config.sizeIndex === index ? 'bg-blue-600/20 border-blue-500' : 'bg-gray-800/50 border-gray-600 hover:border-gray-400'}`}>
                    <div className="font-bold text-lg">{size.name}</div>
                    <div className="text-blue-400 font-mono my-2">{size.width}' x {size.length}'</div>
                    <div className="text-xs text-gray-400">Area: {size.width * size.length} sq ft</div>
                  </button>
                ))}
              </div>
            )}

            {step === 2 && (
              <div className="animate-fade-in grid grid-cols-2 gap-8">
                <div>
                  <h3 className="text-xl font-bold mb-2">2. Premium Sport Surface</h3>
                  <div className="space-y-3">
                    {PRICING.tileBrands.map((brand, idx) => (
                      <div key={brand.id} onClick={() => setConfig(p=>({...p, tileIndex: idx}))} className={`p-3 rounded-lg border cursor-pointer flex justify-between items-center ${config.tileIndex === idx ? 'bg-blue-600/20 border-blue-500' : 'bg-gray-800/50 border-gray-600'}`}>
                        <div>
                          <a href={brand.link} target="_blank" rel="noreferrer" className="font-bold text-blue-300 hover:underline block" onClick={e => e.stopPropagation()}>{brand.name}</a>
                          <span className="text-xs text-gray-400">${brand.pricePerSqFt.toFixed(2)} / sq ft</span>
                        </div>
                        <div className={`w-4 h-4 rounded-full border-2 ${config.tileIndex === idx ? 'border-blue-500 bg-blue-500' : 'border-gray-500'}`}></div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-bold mb-3 text-gray-300 uppercase">Court Colors</h3>
                  <div className="flex gap-4 mb-4">
                    <div>
                      <label className="block text-xs mb-2">Main Area</label>
                      <div className="flex gap-2">{COLORS.map(c => <button key={'main'+c.id} onClick={() => setConfig(p=>({...p, mainColor: c.hex}))} className={`w-8 h-8 rounded-full border-2 ${config.mainColor === c.hex ? 'border-white scale-110' : 'border-transparent'}`} style={{backgroundColor: c.hex}}></button>)}</div>
                    </div>
                    <div>
                      <label className="block text-xs mb-2">Key Area</label>
                      <div className="flex gap-2">{COLORS.map(c => <button key={'key'+c.id} onClick={() => setConfig(p=>({...p, keyColor: c.hex}))} className={`w-8 h-8 rounded-full border-2 ${config.keyColor === c.hex ? 'border-white scale-110' : 'border-transparent'}`} style={{backgroundColor: c.hex}}></button>)}</div>
                    </div>
                  </div>
                  <div className="bg-gray-800/80 p-3 rounded-xl border border-indigo-500/30">
                    <label className="block text-xs font-bold text-indigo-300 mb-2">✨ AI Theme Generator</label>
                    <div className="flex gap-2">
                      <input type="text" value={aiThemePrompt} onChange={(e) => setAiThemePrompt(e.target.value)} placeholder="e.g. Lakers, Cyberpunk..." className="w-full bg-black/50 border border-gray-600 rounded px-2 text-sm focus:border-indigo-400" onKeyDown={(e) => e.key === 'Enter' && handleAiTheme()} />
                      <button onClick={handleAiTheme} disabled={isGeneratingColors || !aiThemePrompt.trim()} className="bg-indigo-600 text-xs px-3 rounded">{isGeneratingColors ? "..." : "Generate"}</button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="animate-fade-in">
                <h3 className="text-xl font-bold mb-2">3. Professional Hoop System</h3>
                <div className="grid grid-cols-3 gap-4">
                  {PRICING.hoops.map((hoop, idx) => (
                    <div key={hoop.id} onClick={() => setConfig(p=>({...p, hoopIndex: idx}))} className={`p-4 rounded-xl border cursor-pointer ${config.hoopIndex === idx ? 'bg-blue-600/20 border-blue-500' : 'bg-gray-800/50 border-gray-600'}`}>
                      <a href={hoop.link} target="_blank" rel="noreferrer" className="font-bold text-lg text-white hover:text-blue-300 underline block mb-1" onClick={e => e.stopPropagation()}>{hoop.name}</a>
                      <div className="text-green-400 font-bold mb-2">${hoop.price.toLocaleString()}</div>
                      <div className="text-xs text-gray-400">{hoop.specs}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="animate-fade-in grid grid-cols-2 gap-6">
                <div className="col-span-2"><h3 className="text-xl font-bold">4. Finishing Touches</h3></div>
                {['Lighting', 'Netting'].map(item => {
                  const key = `has${item}`;
                  const isSelected = config[key];
                  return (
                    <div key={item} onClick={() => setConfig(p=>({...p, [key]: !isSelected}))} className={`p-5 rounded-xl border cursor-pointer flex items-center gap-4 ${isSelected ? 'bg-blue-600/20 border-blue-500' : 'bg-gray-800/50 border-gray-600'}`}>
                      <div className={`w-6 h-6 rounded border ${isSelected ? 'bg-blue-500' : ''}`}>{isSelected && <span className="text-white ml-1">✓</span>}</div>
                      <div>
                        <div className="font-bold text-lg">{PRICING.accessories[item.toLowerCase()].label}</div>
                        <div className="text-green-400 text-sm font-semibold">+${PRICING.accessories[item.toLowerCase()].price}</div>
                      </div>
                    </div>
                  );
                })}
                <div className="col-span-2 mt-2">
                  {!courtHype ? (
                    <button onClick={handleGenerateHype} disabled={isGeneratingHype} className="w-full py-3 border border-indigo-500/50 bg-indigo-600/10 rounded-xl text-indigo-300 font-bold">{isGeneratingHype ? "Drafting..." : "✨ Generate AI Scouting Report"}</button>
                  ) : (
                    <div className="p-4 border border-indigo-500 bg-indigo-900/30 rounded-xl relative shadow-lg">
                      <p className="text-gray-200 text-sm italic">"{courtHype}"</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {step > 0 && (
            <div className="flex justify-between items-center mt-6 pt-6 border-t border-gray-700">
              <button onClick={() => setStep(step - 1)} className="px-6 py-2 rounded-full border border-gray-500 text-gray-300">Back</button>
              {step < 4 ? (
                <button onClick={() => setStep(step + 1)} className="px-8 py-3 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-bold">Next Step</button>
              ) : (
                <button onClick={() => setStep(5)} className="px-8 py-3 rounded-full bg-green-600 hover:bg-green-500 text-white font-bold shadow-[0_0_20px_rgba(22,163,74,0.4)]">Enter Explore Mode</button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Phase 2: Explore Mode & AR Mode UI */}
      {step === 5 && (
        <div className="absolute bottom-10 w-full px-10 flex justify-between items-center z-20 animate-fade-in pointer-events-none">
          <button onClick={() => setStep(4)} className="pointer-events-auto bg-gray-800/80 hover:bg-gray-700 text-white px-6 py-3 rounded-full border border-gray-600 font-bold transition-colors shadow-lg">
            Exit 3D View
          </button>
          
          <div className="bg-black/70 backdrop-blur-md px-6 py-3 rounded-full border border-white/20 shadow-2xl flex items-center gap-3">
            <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"></path></svg>
            <span className="text-sm font-medium text-gray-200">Drag to pan, Scroll to zoom</span>
          </div>

          <button 
            onClick={triggerAR}
            disabled={!isARSupported}
            className={`pointer-events-auto px-6 py-3 rounded-full font-bold transition-all shadow-[0_0_20px_rgba(168,85,247,0.4)] flex items-center gap-2 ${isARSupported ? 'bg-purple-600 hover:bg-purple-500 text-white border border-purple-400' : 'bg-gray-700 text-gray-400 border border-gray-600 cursor-not-allowed'}`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
            <span>{isARSupported ? "View in Backyard (AR)" : "AR Not Supported"}</span>
          </button>
        </div>
      )}
      
      <style>{`.animate-fade-in { animation: fadeIn 0.4s ease-out forwards; } @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
