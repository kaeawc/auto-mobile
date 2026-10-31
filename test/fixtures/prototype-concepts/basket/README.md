# Basket (shop concept, #14223)

An original shop concept: a catalog with categories, a price sort and search, a product page with a
gallery, a size picker and a currency price, a persisted cart, a checked checkout form and a
timed order tracker. `today.json` is the slice that runs on today's vocabulary: the catalog is
literal `data` standing in for the mock backend, and the order moves on a timer.

The slice uses mapped Material icon names so iOS can draw SF Symbols.
The empty cart uses `shopping_cart` (`cart` on iOS); its label identifies the empty state.

## Capabilities used

- `prototype_stack_v1`: shop, product, cart, checkout and order screens.
- `prototype_data_model_v1`: the catalog in `/products` and its price-sorted copy in `/byPrice`.
- `prototype_flow_grid_v1`: the two-column catalog grid.
- `prototype_format_v1`: USD prices on cards, cart lines and the product page.
- `prototype_carousel_v1`: the product gallery.
- `prototype_menus_v1`: the size `select`.
- `prototype_search_bar_v1`: the catalog search field.
- `prototype_string_conditions_v1`: the search note follows the query length.
- `prototype_checks_v1`: checkout field checks, `requireValid` on Pay and `enabledWhen` on quantity.
- `prototype_text_field_options_v1`: outlined, labelled checkout fields and the number keyboard.
- `prototype_storage_v1`: the cart quantities and count survive a relaunch.
- `prototype_timers_v1`: the order tracker advances every 2 s.
- `prototype_semantics_v1`: headings and the tracker's live region.
- `prototype_emit_context_v1`: `added_to_cart`, `search_submitted` and `order_placed` carry their values.

## Test tags

`search_bar`, `search_note`, `category_picker`, `sort_picker`, `catalog_featured`, `catalog_price`,
`product_card`, `product_price`, `product_gallery`, `detail_price`, `variant_select`,
`add_to_cart`, `added_toast`, `cart_empty`, `cart_line`, `qty_minus`, `qty_value`, `qty_plus`,
`cart_count`, `checkout_button`, `name_field`, `street_field`, `postcode_field`, `delivery_date`,
`delivery_slot`, `pay_button`, `order_timeline`, `order_step_0`..`order_step_3`, `order_live`.

## Workarounds and dead ends

| Kind       | Spec path                          | What happens today                                                                                                                                | Needs                                                             |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Dead end   | `search_bar`                       | Typing does not filter: a condition cannot test whether a row's title contains the query, so the query is only emitted on submit                  | derived filter (#14228) or a mock `q=` request (#14271)           |
| Workaround | `catalog_price`, `data.byPrice`    | Sorting by price shows a second, pre-sorted copy of the catalog                                                                                   | derived sort (#14228)                                             |
| Workaround | `product_card` `visibleWhen`       | Category filtering hides cards whose `category` differs from the picked one                                                                       | derived filter (#14228)                                           |
| Workaround | `add_to_cart`                      | One Add button per product, switched by `selectedId`, because the product page cannot `find` its row and `increment` cannot bind a key from state | `find` binding (#14229)                                           |
| Workaround | `state.qty_mug`..`state.qty_throw` | Cart quantities are one state key per product, and `cartCount` is kept by `increment` / `decrement`                                               | keyed writes (#14230), derived count (#14228)                     |
| Dead end   | `cart_count`                       | No line totals, subtotal, tax or total: nothing can multiply or sum                                                                               | derived sum (#14228)                                              |
| Workaround | `product_gallery`                  | Gallery slides are labelled boxes: the slice ships no image assets                                                                                | remote images (#14181)                                            |
| Dead end   | `pay_button`                       | Paying only emits `order_placed`; there is no store sheet and no 503-then-retry path                                                              | fake store (#14314), mock faults and `statusKey` (#14271)         |
| Workaround | `order_timeline`                   | Status steps light up on a 2 s timer; no map, no push per step                                                                                    | scripted actors (#14211), `map` (#14309), simulated push (#14285) |

## Simulator limits

None for this slice: it uses no camera, Bluetooth or payment hardware.
