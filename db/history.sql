WITH page AS (
      SELECT * FROM generation_runs WHERE seq<? ORDER BY seq DESC LIMIT 21
    )
    SELECT p.seq,p.id,p.restaurant,p.recorded,p.upload_ip AS uploadIp,p.image_ip AS imageIp,geo.city AS ipCity,p.legacy,
      COALESCE(m.state,d.state,'unpublished') AS state,
      CASE WHEN p.legacy THEN (SELECT count(*) FROM dish_objects WHERE menu_id=p.id) END AS savedImages,
      CASE WHEN p.legacy THEN json_extract(m.payload,'$.imageSettings') END AS oldSettings,
      count(c.seq) AS attempts,SUM(c.usd) AS usd,count(c.usd) AS priced,
      count(CASE WHEN c.basis='output estimate' THEN 1 END) AS estimates
    FROM page p LEFT JOIN menus m ON m.id=p.id LEFT JOIN drafts d ON d.id=p.id
    LEFT JOIN generation_cities geo ON geo.run_id=p.id AND geo.ip=COALESCE(p.upload_ip,p.image_ip)
    LEFT JOIN generation_calls c ON c.run_id=p.id
    GROUP BY p.seq ORDER BY p.seq DESC
