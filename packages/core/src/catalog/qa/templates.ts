export const CATALOG_QA_TEMPLATE = `The product pixels were copied, never redrawn. Judge cut-out quality and composition, not photo quality.
Score each dimension from 0 to 100:
complete_product: no part of the product or model is cut by the frame.
same_product: image 2 shows the same product as image 1 and, when present, image 3.
edge_quality: clean edges, no halo, eroded fringe, missing straps, laces, mesh or hair.
background_clean: only the flat background colour remains, no leftover scene, props or stray shadow blobs.
no_text_or_watermark: no text, logo overlay, watermark or several photos in one, including small AI-tool marks such as a sparkle or star icon in a corner.
orientation_ok: upright as a shopper expects.
placement_ok: the product sits at <anchor>, with the same placement as other angles, for <channel>.
Return only this JSON object: {"complete_product":0,"same_product":0,"edge_quality":0,"background_clean":0,"no_text_or_watermark":0,"orientation_ok":0,"placement_ok":0,"is_collage":false,"reasons":[]}.
Reasons must be short plain sentences a non-technical person understands, one per failing dimension, lowest score first, naming the thing seen, such as "the model's hand" or "a logo in the corner". Never mention model names or technical identifiers.`;

export const PRODUCT_TYPE_TEMPLATE = `Classify the product in this photo as one of:
footwear: shoes, boots or sandals;
apparel_model: apparel worn on a model;
apparel_flat: apparel laid flat or shown without a model;
bag_accessory: a bag or accessory;
other: anything else.
Return only {"type":"footwear|apparel_model|apparel_flat|bag_accessory|other","confidence":0.0,"transparent":false}, with confidence from 0 to 1. Set transparent true only when the product itself is glass, transparent packaging or transparent material.`;

export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/<([a-zA-Z_]+)>/g, (token, key: string) => vars[key] === undefined ? token : String(vars[key]));
}
