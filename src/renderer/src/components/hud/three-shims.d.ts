/**
 * three@0.185 ships no bundled TypeScript declarations and @types/three is not
 * installed (no new packages allowed in W1). GraphCore is a faithful port of a
 * known-good renderer, so shorthand ambient modules (typed as `any`) are an
 * acceptable trade — remove this file if @types/three is ever added.
 */
declare module 'three'
declare module 'three/examples/jsm/postprocessing/EffectComposer.js'
declare module 'three/examples/jsm/postprocessing/RenderPass.js'
declare module 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
declare module 'three/examples/jsm/postprocessing/OutputPass.js'
