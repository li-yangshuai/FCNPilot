"""Faithful gate-layout and spatial-density PNGs used as model input."""
from __future__ import annotations
import hashlib
from pathlib import Path
import threading

_RENDER_LOCK = threading.Lock()
PHASE_COLORS = {1:"#e1f6e2",2:"#f7e4fa",3:"#e0f5f9",4:"#fffae0"}


def render_layout(candidate, density, path):
    # Matplotlib's stateful font/render infrastructure is serialized across cases.
    with _RENDER_LOCK:
        return _render(candidate, density, Path(path))


def _render(candidate, density, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle
    from matplotlib.colors import Normalize
    import numpy as np
    nodes = candidate["nodes"]
    routes = candidate["routes"]
    points = [(n["x"],n["y"]) for n in nodes]
    points += [tuple(p) for route in routes for p in route["path"]]
    minx,maxx = min(p[0] for p in points),max(p[0] for p in points)
    miny,maxy = min(p[1] for p in points),max(p[1] for p in points)
    width,height=maxx-minx+1,maxy-miny+1
    if width*height>65536:
        raise ValueError("The research image renderer is bounded to 65536 native tile sites")
    # Equal tile aspect, actual coordinates; never independently normalize pins.
    fig,axes=plt.subplots(1,2,figsize=(12,7.6),dpi=130,layout="constrained")
    ax,heat=axes
    for cell in candidate.get("cells",[]):
        ax.add_patch(Rectangle((cell["x"]-.47,cell["y"]-.47),.94,.94,
                               color=PHASE_COLORS.get(cell["phase"],"#eeeeee"),zorder=0))
    for route in routes:
        xy=np.asarray(route["path"])
        ax.plot(xy[:,0],xy[:,1],color="#64758a",linewidth=1.05,alpha=.78,zorder=1)
        if len(xy)>1:
            a,b=xy[-2],xy[-1]
            mid=(a+b)/2
            ax.annotate("",xy=b,xytext=mid,
                        arrowprops={"arrowstyle":"->","color":"#526377","lw":.8},zorder=2)
    for n in nodes:
        fixed=n["is_input"] or n["is_output"]
        color="#008dc8" if n["is_input"] else "#e28686" if n["is_output"] else "#ffffff"
        marker="s" if fixed else "o"
        ax.scatter(n["x"],n["y"],s=175 if len(nodes)<25 else 115,marker=marker,
                   facecolor=color,edgecolor="#16394d",linewidth=1.0,zorder=4)
        ax.text(n["x"],n["y"],str(n["id"]),ha="center",va="center",
                fontsize=7.3 if len(nodes)<25 else 6.3,color="#152838",weight="bold",zorder=5)
    occupied=set(points)
    # Actual 5x5 union occupancy, clipped at the routed boundary.
    grid=np.zeros((height,width))
    for yi,y in enumerate(range(miny,maxy+1)):
        for xi,x in enumerate(range(minx,maxx+1)):
            window=[(xx,yy) for yy in range(max(miny,y-2),min(maxy,y+2)+1)
                    for xx in range(max(minx,x-2),min(maxx,x+2)+1)]
            grid[yi,xi]=sum(p in occupied for p in window)/len(window)
    im=heat.imshow(grid,origin="upper",extent=(minx-.5,maxx+.5,maxy+.5,miny-.5),
                   cmap="YlOrRd",norm=Normalize(0,1),interpolation="nearest")
    for n in nodes:
        fixed=n["is_input"] or n["is_output"]
        heat.plot(n["x"],n["y"],"s" if fixed else "o",markersize=4.5 if fixed else 3,
                  markerfacecolor="#1b263b" if fixed else "white",
                  markeredgecolor="#1b263b",markeredgewidth=.5)
    # Label only the first eight region centers to keep the map legible.
    # JSON carries exact bounds for every region, including the unlabelled ones.
    for index,region in enumerate(density["regions"][:8],1):
        b=region["bounds"]
        heat.add_patch(Rectangle((b["min_x"]-.5,b["min_y"]-.5),
                                 b["max_x"]-b["min_x"]+1,b["max_y"]-b["min_y"]+1,
                                 fill=False,edgecolor="#2450a4",linewidth=.7,linestyle="--"))
        heat.text(b["min_x"],b["min_y"]-.6,f"R{index}",fontsize=8,
                  color="#123f86",ha="left",va="bottom",
                  bbox={"facecolor":"white","edgecolor":"none","pad":.5,"alpha":.8})
    for target in axes:
        target.set_xlim(minx-1,maxx+1)
        target.set_ylim(maxy+1,miny-1)
        target.set_aspect("equal")
        target.set_xlabel("Native tile x")
        target.set_ylabel("Native tile y (increases downward)")
        target.set_xticks(range(minx,maxx+1,max(1,width//8)))
        target.set_yticks(range(miny,maxy+1,max(1,height//12)))
        target.grid(color="#78909c",alpha=.13,linewidth=.4)
    ax.set_title("Actual routed layout | node IDs",fontsize=12)
    heat.set_title("Local occupied-site density | 5 x 5 tiles",fontsize=12)
    fig.colorbar(im,ax=heat,shrink=.62,pad=.02,label="Gate + old-wire site fraction")
    fig.suptitle("Fixed I/O squares; movable internal circles. White gaps are opportunities, not legality certificates.",
                 fontsize=10)
    path.parent.mkdir(parents=True,exist_ok=True)
    fig.savefig(path,dpi=130)
    plt.close(fig)
    return {"path":str(path),"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),
             "mime_type":"image/png","bytes":path.stat().st_size,
            "region_labels": {f"R{i}":region["region_id"] for i,region in enumerate(density["regions"][:8],1)},
            "coordinates":"Unnormalized native candidate XY; I/O coordinates shared across iterations",
            "density":"5x5 gate/old-route union site fraction; not QCA-cell density or DRC"}

