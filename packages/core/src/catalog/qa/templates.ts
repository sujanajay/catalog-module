/**
 * The judge prompt (07 4.2, v2, views amendment). Roles are explicit: image 1 is the source photo,
 * image 2 the output we rendered from it, image 3 photo 1 of the same product id for reference only.
 * The judge names the view first so that a sole, back, inside, detail, on-model, packshot, single item
 * of a multipack or a size chart of the same listing is never mistaken for a different product.
 * Placement is not asked: code checks it exactly (05). The JSON keys are the ones `judge.ts` reads.
 * `product_intact` (flag `product_removed`) compares how much of the product image 2 still shows;
 * `background_clean` needs a sentence that says where the leftover is.
 */
export const CATALOG_QA_TEMPLATE = `You check one product photo for an online catalogue.
Image 1 is the source photo the brand supplied. Image 2 is the output we rendered from image 1 for <channel>: the product pixels were copied from image 1, never redrawn; only the background, size and position changed. Image 3, when present, is photo 1 of the same product id, for reference only. The product type is <productType>.
Work in this order.
1. view: name the view that image 1 shows, one of front, side, back, sole, top, inside, detail, on-model, flat, chart. Use chart for a size chart, a measurement guide, a care-instruction graphic or any image that is mostly text, a table or a diagram rather than a photo of the product.
2. wrong_item: a product id usually has several photos of one item. Other angles, the back, the sole, the inside, close-ups of a detail and on-model shots of the same item are expected and are never a different item, even when they look very different from image 3. These are always the same product, so wrong_item is false for them:
- a single item out of a multipack or set shown in image 3, such as one brief of a 3-pack or one sock of a pair;
- a packshot or flat product photo against the same product worn on a model or on legs, either way round;
- a size chart, care label, measurement guide or infographic of the listing;
- a detail or close-up of any part of the product, such as fabric, a logo, a label, a zip or a buckle;
- exactly the same design in another colour, because one product id can show its colours; a different design in another colour is not this case.
Return true only when image 1 clearly shows a different item: another category of product (for example a bag under a shoe listing), or a clearly different design that no angle, multipack, colour or close-up explains. Return false when you are unsure or when there is no image 3.
3. Score image 1, the photo itself, from 0 to 100, where 100 means no problem:
complete_product: no part of the product is cut off by the frame edge of image 1. A detail close-up, or an on-model shot that crops the model but shows the product, scores 100.
no_text_or_watermark: no added text, logo overlay, watermark or price tag, including small AI-tool marks such as a sparkle or star icon in a corner. Brand names, labels and prints that are part of the product itself score 100. A chart view scores 100 here; it is handled separately.
orientation_ok: the product is upright as a shopper expects for this view.
is_collage: true only when image 1 combines several separate photos in one frame.
4. Score image 2 against image 1, from 0 to 100:
product_intact: image 2 still shows all of the product that image 1 shows. Score below 40 when the cut-out removed a substantial part of the product: missing fabric, missing body of a bag or shoe, a missing sleeve, leg or strap, holes through the product, or only a logo, label, zip or piece of hardware left floating where the product was. A logo or label on its own is not the product. When image 1 is a close-up filled edge to edge by the product, image 2 must still show that whole area of product. The model's skin and hair in an on-model photo count as kept.
edge_quality: clean edges, no halo, no eroded fringe, and no small parts of the product missing compared with image 1, such as straps, laces, mesh or hair.
background_clean: only the flat background colour remains around the product, with at most a soft natural shadow under it; no leftover scene, props, blocks or stray shadow patches. Score below 75 only when you can point to the leftover: say where it is in image 2.
Do not judge where the product sits in the frame or how big it is; that is checked separately.
5. evidence: for wrong_item true, is_collage true and every score below 80, one short plain sentence a non-technical person understands, naming the thing seen and where it is, such as "the model's hand is cut off at the bottom edge", "a grey block remains to the left of the shoe" or "only the gold logo is left; the orange leather around it is gone". Never mention model names or technical identifiers.
Return only this JSON object: {"view":"front","wrong_item":false,"complete_product":100,"no_text_or_watermark":100,"orientation_ok":100,"is_collage":false,"product_intact":100,"edge_quality":100,"background_clean":100,"evidence":{}}, where evidence maps a check name to its sentence.`;

/** Plain words for the product type line of the judge prompt. */
export const PRODUCT_TYPE_WORDS: Record<string, string> = {
  footwear: "footwear (shoes, boots or sandals)",
  apparel_model: "apparel worn on a model",
  apparel_flat: "apparel laid flat or shown without a model",
  bag_accessory: "a bag or accessory",
  other: "a general product",
  auto: "not known",
};

export const PRODUCT_TYPE_TEMPLATE = `Classify the product in this photo as one of:
footwear: shoes, boots or sandals;
apparel_model: apparel worn on a model;
apparel_flat: apparel laid flat or shown without a model;
bag_accessory: a bag or accessory;
other: anything else.
Return only {"type":"footwear|apparel_model|apparel_flat|bag_accessory|other","confidence":0.0,"transparent":false,"chart":false}, with confidence from 0 to 1. Set transparent true only when the product itself is glass, transparent packaging or transparent material. Set chart true only when the photo is a size chart, measurement guide, care-instruction graphic or another image that is mostly text, a table or a diagram rather than a photo of the product; then give the type of product the chart is for when you can tell, else other.`;

export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/<([a-zA-Z_]+)>/g, (token, key: string) => vars[key] === undefined ? token : String(vars[key]));
}
