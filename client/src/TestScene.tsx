import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { MapConfig } from "../../shared/types.ts";

type TestSceneProps = {
  config: MapConfig;
  modelUrl?: string | null;
};

export default function TestScene({ config, modelUrl = null }: TestSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#dce8e2");
    scene.fog = new THREE.Fog("#dce8e2", 55, 125);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 180);
    camera.position.set(42, 32, 44);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 18;
    controls.maxDistance = 105;

    scene.add(new THREE.HemisphereLight("#f7fff9", "#71827b", 2.5));
    const sun = new THREE.DirectionalLight("#fff4d6", 3.2);
    sun.position.set(-25, 45, 22);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(92, 72),
      new THREE.MeshStandardMaterial({ color: "#b4cdbb", roughness: 0.9 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(92, 23, "#759888", "#a1b9aa");
    grid.position.y = 0.03;
    grid.material.transparent = true;
    grid.material.opacity = 0.33;
    scene.add(grid);

    if (modelUrl) {
      const loader = new GLTFLoader();
      loader.load(
        modelUrl,
        (gltf) => {
          const model = gltf.scene;
          const originalBounds = new THREE.Box3().setFromObject(model);
          const originalCenter = originalBounds.getCenter(new THREE.Vector3());
          const originalSize = originalBounds.getSize(new THREE.Vector3());
          const longestSide = Math.max(originalSize.x, originalSize.y, originalSize.z, 1);
          const wrapper = new THREE.Group();

          model.position.sub(originalCenter);
          model.updateMatrixWorld(true);
          const centeredBounds = new THREE.Box3().setFromObject(model);
          model.position.y -= centeredBounds.min.y;
          model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          wrapper.scale.setScalar(64 / longestSide);
          wrapper.add(model);
          scene.add(wrapper);
        },
        undefined,
        (error) => console.error("地图模型加载失败", error),
      );
    } else {
      const roadMaterial = new THREE.MeshStandardMaterial({ color: "#8f9d9b", roughness: 1 });
      const pathMaterial = new THREE.MeshStandardMaterial({ color: "#d4c8a4", roughness: 1 });
      const buildingMaterial = new THREE.MeshStandardMaterial({ color: "#e9eee7", roughness: 0.75 });
      const roofMaterial = new THREE.MeshStandardMaterial({ color: "#bd6d4e", roughness: 0.8 });
      const darkMaterial = new THREE.MeshStandardMaterial({ color: "#314c4a", roughness: 0.8 });

      function addBox(size: [number, number, number], position: [number, number, number], material: THREE.Material, castShadow = true) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
        mesh.position.set(...position);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        scene.add(mesh);
        return mesh;
      }

      addBox([68, 0.08, 5], [0, 0.08, 10], roadMaterial, false);
      addBox([5, 0.09, 52], [0, 0.09, -8], roadMaterial, false);
      addBox([28, 0.1, 4], [-17, 0.1, -2], pathMaterial, false);
      addBox([4, 0.1, 24], [19, 0.1, -10], pathMaterial, false);

      const library = addBox([18, 8, 13], [-16, 4, -13], buildingMaterial);
      library.name = "图书馆";
      addBox([19, 0.9, 14], [-16, 8.45, -13], roofMaterial);
      addBox([8, 2.6, 0.4], [-16, 3.8, -19.65], darkMaterial, false);

      const lab = addBox([17, 11, 13], [19, 5.5, -12], buildingMaterial);
      lab.name = "实验楼";
      addBox([18, 0.9, 14], [19, 11.5, -12], roofMaterial);
      addBox([7, 3.2, 0.4], [19, 4.2, -18.65], darkMaterial, false);

      const hall = addBox([18, 5.5, 9], [15, 2.75, 19], buildingMaterial);
      hall.name = "活动中心";
      addBox([19, 0.75, 10], [15, 5.9, 19], roofMaterial);

      function addTree(x: number, z: number, scale = 1) {
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28 * scale, 0.42 * scale, 2.3 * scale, 10),
          new THREE.MeshStandardMaterial({ color: "#76583e" }),
        );
        trunk.position.set(x, 1.15 * scale, z);
        trunk.castShadow = true;
        scene.add(trunk);
        const crown = new THREE.Mesh(
          new THREE.DodecahedronGeometry(2.1 * scale, 1),
          new THREE.MeshStandardMaterial({ color: "#3f7258", roughness: 0.95 }),
        );
        crown.position.set(x, 3.25 * scale, z);
        crown.castShadow = true;
        scene.add(crown);
      }

      [
        [-31, -25, 1.2], [-26, 24, 0.9], [-8, 25, 1.1], [30, 21, 1.1],
        [33, -1, 0.85], [-29, 5, 1], [7, -25, 0.9], [29, -25, 1.2],
      ].forEach(([x, z, scale]) => addTree(x, z, scale));
    }

    const markerMaterials = {
      attacker: new THREE.MeshStandardMaterial({ color: "#d8684d", emissive: "#4e170e", emissiveIntensity: 0.4 }),
      defender: new THREE.MeshStandardMaterial({ color: "#287d8a", emissive: "#082f37", emissiveIntensity: 0.35 }),
      seeker: new THREE.MeshStandardMaterial({ color: "#d8684d", emissive: "#4e170e", emissiveIntensity: 0.4 }),
      hider: new THREE.MeshStandardMaterial({ color: "#287d8a", emissive: "#082f37", emissiveIntensity: 0.35 }),
      hide: new THREE.MeshBasicMaterial({ color: "#39a98b", transparent: true, opacity: 0.2, side: THREE.DoubleSide }),
      forbidden: new THREE.MeshBasicMaterial({ color: "#d8684d", transparent: true, opacity: 0.2, side: THREE.DoubleSide }),
    };

    config.spawnPoints.forEach((point) => {
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.15, 32), markerMaterials[point.role]);
      marker.position.set(point.position[0], 0.14, point.position[2]);
      scene.add(marker);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.18, 32), markerMaterials[point.role]);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(point.position[0], 0.18, point.position[2]);
      scene.add(ring);
    });

    config.zones.forEach((zone) => {
      const zoneMesh = new THREE.Mesh(new THREE.CylinderGeometry(zone.radius, zone.radius, 0.06, 48), markerMaterials[zone.kind === "hide" ? "hide" : "forbidden"]);
      zoneMesh.position.set(zone.center[0], 0.13, zone.center[2]);
      scene.add(zoneMesh);
    });

    const pulse = new THREE.Mesh(
      new THREE.RingGeometry(1.25, 1.38, 32),
      new THREE.MeshBasicMaterial({ color: "#f6c453", transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.set(0, 0.2, 22);
    scene.add(pulse);

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    let animationFrame = 0;
    const animate = (time: number) => {
      pulse.scale.setScalar(1 + Math.sin(time * 0.004) * 0.18);
      pulse.material.opacity = 0.52 + (Math.sin(time * 0.004) + 1) * 0.18;
      controls.update();
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [config, modelUrl]);

  return <div className="test-scene" ref={mountRef} aria-label="校园测试三维场景" />;
}
