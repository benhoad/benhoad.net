import * as THREE from '/three.module.js';
import {OrbitControls} from '/OrbitControls.js';
import {GLTFLoader} from '/GLTFLoader.js';

function main() {
  const canvas = document.getElementById('spinner');
  const renderer = new THREE.WebGLRenderer({canvas});
  renderer.physicallyCorrectLights = true;
  const fov = 25;
  const aspect = 2;  // the canvas default
  const near = 0.1;
  const far = 100;
  const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  camera.position.set(0, 10, 20);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 5, 0);
  controls.update();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('white');

  let pmremGenerator = new THREE.PMREMGenerator( renderer );
  pmremGenerator.compileEquirectangularShader();

  let content;

  addLights();

  // {
  //   const skyColor = 0xB1E1FF;  // light blue
  //   const groundColor = 0xFFFFFF;  // brownish orange
  //   const intensity = 1.6;
  //   const light = new THREE.HemisphereLight(skyColor, groundColor, intensity);
  //   scene.add(light);
  // }

  // {
  //   const color = 0xFFFFFF;
  //   const intensity = 2;
  //   const light = new THREE.DirectionalLight(color, intensity);
  //   light.position.set(5, 10, 2);
  //   scene.add(light);
  //   scene.add(light.target);
  // }



  function frameArea(sizeToFitOnScreen, boxSize, boxCenter, camera) {
    const halfSizeToFitOnScreen = sizeToFitOnScreen * 0.5;
    const halfFovY = THREE.MathUtils.degToRad(camera.fov * .8);
    const distance = halfSizeToFitOnScreen / Math.tan(halfFovY);
    // compute a unit vector that points in the direction the camera is now
    // in the xz plane from the center of the box
    const direction = (new THREE.Vector3())
        .subVectors(camera.position, boxCenter)
        .multiply(new THREE.Vector3(1, 0, 1))
        .normalize();

    // move the camera to a position distance units way from the center
    // in whatever direction the camera was from the center already
    camera.position.copy(direction.multiplyScalar(distance).add(boxCenter));
    camera.position.set(5, 5, 10);
    // pick some near and far values for the frustum that
    // will contain the box.
    camera.near = boxSize / 100;
    camera.far = boxSize * 100;

    camera.updateProjectionMatrix();

    // point the camera to look at the center of the box
    camera.lookAt(boxCenter.x, boxCenter.y, boxCenter.z);
  }

  {
    

    const gltfLoader = new GLTFLoader();
 
    gltfLoader.load('/train.gltf', (gltf) => {
      const root = gltf.scene || gltf.scenes[0];
      content = root;
      updateTextureEncoding(root);
      scene.add(root);
      
      root.traverse((node) => {
        if (node.isLight) {
          
        } else if (node.isMesh) {
          node.material.depthWrite = !node.material.transparent;
        }
      });

      renderer.toneMappingExposure = 0.9;

      // compute the box that contains all the stuff
      // from root and below
      const box = new THREE.Box3().setFromObject(root);

      const boxSize = box.getSize(new THREE.Vector3()).length();
      const boxCenter = box.getCenter(new THREE.Vector3());

      // set the camera to frame the box
      frameArea(boxSize, boxSize*2, boxCenter, camera);

      // update the Trackball controls to handle the new size
      controls.maxDistance = boxSize * 10;
      controls.target.copy(boxCenter);
      controls.update();
      
      
      
    });
  }

  function addLights () {
    
    const hemiLight = new THREE.HemisphereLight();
    hemiLight.name = 'hemi_light';
    scene.add(hemiLight);

    const light1  = new THREE.AmbientLight(0xFFFFFF, 0.6);
    light1.name = 'ambient_light';
    camera.add( light1 );

    const light2  = new THREE.DirectionalLight(0xFFFFFF, 3);
    light2.position.copy(camera.position);
    light2.position.set(0.5, 0, 0.866); // ~60º
    light2.name = 'main_light';
    camera.add( light2 );

    scene.add(camera);

    console.log(camera);
  }

  function resizeRendererToDisplaySize(renderer) {
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const needResize = canvas.width !== width || canvas.height !== height;
    if (needResize) {
      renderer.setSize(width, height, false);
    }
    return needResize;
  }

  function updateTextureEncoding (obj) {
    const encoding = THREE.sRGBEncoding;
    traverseMaterials(obj, (material) => {
      if (material.map) material.map.encoding = encoding;
      if (material.emissiveMap) material.emissiveMap.encoding = encoding;
    });
  }

  function traverseMaterials (object, callback) {
    console.log(object);
    object.traverse((node) => {
      if (!node.isMesh) return;
      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];
      materials.forEach(callback);
    });
  }
  

  function render(time) {
    time *= 0.001;  // convert to seconds

    renderer.render(scene, camera);
    controls.autoRotate = true;
    controls.autoRotateSpeed = 4;
    controls.update();

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

main();