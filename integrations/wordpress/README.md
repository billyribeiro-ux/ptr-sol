# WordPress JWT link

This plugin reconstructs a WordPress integration from the captured `protradingroom` shortcode and this application's JWT endpoint. It is not the original WordPress plugin. Copy `protradingroom.php` into a plugin directory and activate it. In `wp-config.php`, configure the HTTPS application origin and map the room's internal ID to its room SSO secret:

```php
define('PTR_ROOM_ORIGIN', 'https://rooms.example.com');
define('PTR_ROOM_SECRETS', array('ROOM_INTERNAL_ID' => 'ROOM_SSO_SECRET_AT_LEAST_32_BYTES'));
```

Set the room's authorization mode to JWT or SSO and use the same secret. Add `[protradingroom room='ROOM_INTERNAL_ID' link_text='Enter Room' mode='urlv3']` to a page. The captured shortcode also accepts a `key` attribute, but storing the secret in `wp-config.php` keeps it out of page content and revisions. Only authenticated WordPress users see the link. An HTTP origin is allowed only for localhost development.

The link holds a random, one-use, two-minute WordPress ticket tied to the current user and a WordPress nonce. When clicked, the server signs a room-bound JWT, valid for two minutes, and redirects to the application's JWT handoff. Protect both sites with HTTPS; the JWT appears in the redirect URL and may be recorded in access logs. WordPress roles are passed as permissions. Trusted server-side integrations can map membership and product identifiers with the `ptr_room_memberships`, `ptr_room_products`, and `ptr_room_permissions` filters; each receives the current array, WP user, and room ID. Values must match the room's configured filters. The application uses existing room membership roles for authorization, so a WordPress role does not grant room administration.

If configured in the room, supply optional values with `PTR_ROOM_SECURITY_TOKENS` and `PTR_ROOM_AUDIENCES` arrays keyed by room ID. Both room modes use the same verified JWT handoff in this reconstruction. Compatibility with opaque legacy SSO tokens remains unverified because that protocol was not captured.
